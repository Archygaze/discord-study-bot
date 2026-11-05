require('dotenv').config();
const {
  Client,
  Events,
  ActivityType,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

// Prevent unhandled errors from crashing the bot process
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

// Active study sessions per voice channel ID
// Map<channelId, { guildId, studyChannelId, breakChannelId, participants: Set<userId>, participantNames: string[], endTime, timeoutId, intervalId, messageId, durationMinutes }>
const activeSessions = new Map();

// Track which user is locked into which study channel for instant move-back enforcement
// Map<userId, studyChannelId>
const lockedUsers = new Map();

// Track paused sessions when a user logs off / disconnects before their timer finishes
// Map<userId, { remainingMs: number, originalMinutes: number }>
const pausedSessions = new Map();

// Track pending timers when a user runs /focus alone from text chat before connecting to voice
// Map<channelId, { userId: string, durationMs: number, originalMinutes: number, isResumed: boolean }>
const pendingRoomTimers = new Map();

// Track dynamically spawned study rooms so they auto-delete when empty
// Set<channelId>
const dynamicStudyRooms = new Set();

// Track rooms currently being spawned so a brief delay before user joins doesn't delete them
// Set<channelId>
const spawningRooms = new Set();

// Channel names
const CREATE_SOLO_NAME = '➕ New Solo Study';
const CREATE_GROUP_NAME = '➕ New Group Study';
const BREAK_CHANNEL_NAME = process.env.BREAK_CHANNEL_NAME || '☕ Break Lounge';

const commands = [
  new SlashCommandBuilder()
    .setName('setup-study')
    .setDescription('Sets up Join-to-Create Solo & Group Study rooms + one Break Lounge')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName('study')
    .setDescription('Move into a Solo or Group Study Room and start a focus session from any chat!')
    .addSubcommand((sub) =>
      sub
        .setName('alone')
        .setDescription('Create & move into a 1-person Solo Study Room')
        .addIntegerOption((opt) =>
          opt
            .setName('minutes')
            .setDescription('Focus timer in minutes (optional — or pick with buttons)')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(240)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('together')
        .setDescription('Create & move into a Group Study Room together with your friends!')
        .addStringOption((opt) =>
          opt
            .setName('friends')
            .setDescription('Tag as many friends as you want! (e.g. @friend1 @friend2 @friend3...)')
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('minutes')
            .setDescription('Focus timer in minutes (optional — or pick with buttons)')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(240)
        )
    ),
  new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('End your current focus session early and move to the Break Lounge'),
].map((cmd) => cmd.toJSON());

// Helper: Check if a channel is a "Join-to-Create" generator channel
function isGeneratorChannel(channel) {
  if (!channel || channel.type !== ChannelType.GuildVoice) return false;
  const name = channel.name.toLowerCase();
  return name.includes('➕') || name.includes('new solo') || name.includes('new group');
}

// Helper: Check if a channel is the Break Lounge
function isBreakChannel(channel) {
  if (!channel || channel.type !== ChannelType.GuildVoice) return false;
  const name = channel.name.toLowerCase();
  return (
    channel.id === process.env.BREAK_CHANNEL_ID ||
    name.includes('break') ||
    name.includes('lounge') ||
    channel.name === BREAK_CHANNEL_NAME
  );
}

// Helper: Check if a channel is a dynamic Study Room that should auto-delete when empty
function isDynamicRoom(channel) {
  if (!channel || channel.type !== ChannelType.GuildVoice) return false;
  if (isGeneratorChannel(channel) || isBreakChannel(channel)) return false;
  if (dynamicStudyRooms.has(channel.id)) return true;
  const name = channel.name.toLowerCase();
  return (
    name.includes('study room') ||
    name.includes('study together') ||
    name.includes("'s study") ||
    name.includes('🎧') ||
    name.includes('📖') ||
    name.includes('👥')
  );
}

// Helper: Check if a channel is an active/spawned Study Room (not a generator)
function isStudyChannel(channel) {
  return isDynamicRoom(channel);
}

// Helper: Get next available room number (e.g. 📖 Study Room #1, #2, #3...)
function getNextRoomName(guild, isSolo) {
  const prefix = isSolo ? '📖 Study Room #' : '👥 Study Together #';
  let num = 1;
  while (
    guild.channels.cache.some(
      (ch) => ch.type === ChannelType.GuildVoice && ch.name === `${prefix}${num}`
    )
  ) {
    num++;
  }
  return `${prefix}${num}`;
}

// Helper: Find Break Lounge in a guild
function findBreakChannel(guild) {
  return guild.channels.cache.find((ch) => isBreakChannel(ch));
}

// Helper: Find the STUDY ZONE category in a guild
function findStudyCategory(guild) {
  return guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toUpperCase().includes('STUDY')
  );
}

// Helper: Spawn a new Solo or Group Study Room
async function spawnStudyRoom(guild, isSolo, parentCategoryId = null, graceMs = 20000) {
  const category =
    parentCategoryId || (findStudyCategory(guild) && findStudyCategory(guild).id) || null;
  const roomName = getNextRoomName(guild, isSolo);

  const spawnedRoom = await guild.channels.create({
    name: roomName,
    type: ChannelType.GuildVoice,
    parent: category,
    userLimit: isSolo ? 1 : 0,
  });

  dynamicStudyRooms.add(spawnedRoom.id);
  spawningRooms.add(spawnedRoom.id);
  setTimeout(() => spawningRooms.delete(spawnedRoom.id), graceMs);

  return spawnedRoom;
}

// Helper: Set Discord Voice Channel Status ("Set a channel status")
async function setVoiceChannelStatus(channelId, statusText) {
  try {
    await rest.put(`/channels/${channelId}/voice-status`, {
      body: { status: statusText || '' },
    });
  } catch (err) {
    console.error(`Could not update voice status for channel ${channelId}:`, err.message);
  }
}

// Helper: Format the voice status string ("username is studying • Xm left")
function formatStudyStatus(participantNames, minutesLeft) {
  const names = participantNames.join(', ');
  const verb = participantNames.length === 1 ? 'is' : 'are';
  const text = `🔒 ${names} ${verb} studying • ${minutesLeft}m left`;
  return text.slice(0, 480);
}

// Build the prompt message with duration buttons
function buildPromptPayload(studyChannel, isSolo, includeJoinButton = false) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(isSolo ? `📖 ${studyChannel.name} (Solo)` : `👥 ${studyChannel.name} (Group)`)
    .setDescription(
      `Welcome to <#${studyChannel.id}>!\n` +
        (isSolo
          ? `This is your **1-person** study room.\n\n`
          : `Invite your friends to join <#${studyChannel.id}> first, then pick a timer to lock everyone in!\n\n`) +
        `Select a timer below (or type \`/study alone\` / \`/study together\`) to **start & lock in**:\n` +
        `• 🔒 **Room Locks:** Nobody else can enter while the timer runs.\n` +
        `• 💬 **Live Status:** Sets the channel status to \`[Username] is studying • Xm left\`.\n` +
        `• 🚫 **No Channel Hopping:** Switching channels pulls you right back here.\n` +
        `• 💾 **Auto-Save on Disconnect:** If you log off early, your room deletes and your remaining time resumes next time!\n` +
        `• ☕ **Auto-Break:** Moves everyone to **${BREAK_CHANNEL_NAME}** & deletes the room when done!`
    )
    .setFooter({ text: 'Choose a focus duration below to lock in' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`focus_20_${studyChannel.id}`)
      .setLabel('20 Min')
      .setEmoji('🍅')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`focus_30_${studyChannel.id}`)
      .setLabel('30 Min')
      .setEmoji('⏱️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`focus_60_${studyChannel.id}`)
      .setLabel('60 Min')
      .setEmoji('🔥')
      .setStyle(ButtonStyle.Success)
  );

  if (includeJoinButton) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel(`Join ${studyChannel.name}`)
        .setEmoji('🔊')
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/channels/${studyChannel.guild.id}/${studyChannel.id}`)
    );
  }

  return { embeds: [embed], components: [row] };
}

// Start or resume a locked study session in a specific studyChannel
async function startFocusSession(
  guild,
  studyChannel,
  breakChannel,
  durationMs,
  starterUser,
  isResumed = false,
  originalMinutes = null
) {
  if (activeSessions.has(studyChannel.id)) {
    return { ok: false, error: 'A focus session is already running in this room!' };
  }

  // Fetch latest channel state so newly moved members are included
  const freshChannel = await guild.channels.fetch(studyChannel.id).catch(() => studyChannel);
  const membersInRoom = Array.from(freshChannel.members.values()).filter((m) => !m.user.bot);
  if (membersInRoom.length === 0) {
    return {
      ok: false,
      error: `Join <#${studyChannel.id}> first to start the focus timer!`,
    };
  }

  const participantIds = new Set(membersInRoom.map((m) => m.id));
  const participantNames = membersInRoom.map((m) => m.displayName || m.user.username);
  const displayMinutes = Math.max(1, Math.ceil(durationMs / 60000));
  const totalMinutes = originalMinutes || displayMinutes;

  for (const userId of participantIds) {
    lockedUsers.set(userId, studyChannel.id);
    pausedSessions.delete(userId);
  }

  // Lock Method A: Set userLimit to exact participant count (only requires Manage Channels!)
  await studyChannel.setUserLimit(Math.max(1, participantIds.size)).catch(() => {});

  // Lock Method B: Also apply permission overwrites if the bot has Manage Roles in this server
  try {
    await studyChannel.permissionOverwrites.edit(client.user.id, {
      ViewChannel: true,
      Connect: true,
      SendMessages: true,
      ManageChannels: true,
      MoveMembers: true,
    });
    for (const userId of participantIds) {
      await studyChannel.permissionOverwrites.edit(userId, { Connect: true });
    }
    await studyChannel.permissionOverwrites.edit(guild.roles.everyone, { Connect: false });
  } catch {
    // Even without Manage Roles, Method A (userLimit) + Method C (auto-bouncing outsiders) locks the room!
  }

  const endTimeMs = Date.now() + durationMs;
  const endTimestampSec = Math.floor(endTimeMs / 1000);

  // 4. Set the Voice Channel Status immediately ("🔒 username is studying • Xm left")
  await setVoiceChannelStatus(
    studyChannel.id,
    formatStudyStatus(participantNames, displayMinutes)
  );

  // Update the Voice Channel Status every minute as the timer counts down
  const intervalId = setInterval(async () => {
    const remainingMs = endTimeMs - Date.now();
    if (remainingMs <= 0) return;
    const minsLeft = Math.max(1, Math.ceil(remainingMs / 60000));
    await setVoiceChannelStatus(studyChannel.id, formatStudyStatus(participantNames, minsLeft));
  }, 60 * 1000);

  const embed = new EmbedBuilder()
    .setColor(isResumed ? 0xfee75c : 0xed4245)
    .setTitle(
      isResumed
        ? `🔄 Resumed Focus Session (${displayMinutes} mins left)`
        : `🔒 Focus Session Locked (${displayMinutes} mins)`
    )
    .setDescription(
      (isResumed
        ? `Welcome back <@${starterUser.id}>! Continuing your previous **${totalMinutes}-minute** session in <#${studyChannel.id}>.\n\n`
        : `Started by <@${starterUser.id}> in <#${studyChannel.id}>\n\n`) +
        `💬 **Channel Status:** \`${formatStudyStatus(participantNames, displayMinutes)}\`\n` +
        `⏳ **Ends:** <t:${endTimestampSec}:R> (at <t:${endTimestampSec}:t>)\n` +
        `👥 **Locked-in:** ${Array.from(participantIds)
          .map((id) => `<@${id}>`)
          .join(', ')}\n\n` +
        `*This room is locked to outsiders. If you log off early, your remaining time will be saved!*`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`focus_unlock_${studyChannel.id}`)
      .setLabel('End Session & Unlock Early')
      .setEmoji('🔓')
      .setStyle(ButtonStyle.Danger)
  );

  const msg = await studyChannel.send({ embeds: [embed], components: [row] });

  const timeoutId = setTimeout(() => {
    endFocusSession(studyChannel.id, false);
  }, durationMs);

  activeSessions.set(studyChannel.id, {
    guildId: guild.id,
    studyChannelId: studyChannel.id,
    breakChannelId: breakChannel ? breakChannel.id : null,
    participants: participantIds,
    participantNames,
    endTime: endTimeMs,
    timeoutId,
    intervalId,
    messageId: msg.id,
    durationMinutes: totalMinutes,
  });

  return { ok: true, embed, row };
}

// End a study session, move members to the single Break Lounge, and delete dynamic room
async function endFocusSession(studyChannelId, endedEarly = false, endedByUser = null) {
  const session = activeSessions.get(studyChannelId);
  if (!session) return;

  clearTimeout(session.timeoutId);
  clearInterval(session.intervalId);
  activeSessions.delete(studyChannelId);

  for (const userId of session.participants) {
    lockedUsers.delete(userId);
    pausedSessions.delete(userId);
  }

  try {
    const guild = await client.guilds.fetch(session.guildId);
    const studyChannel = await guild.channels.fetch(session.studyChannelId).catch(() => null);
    const foundBreak = findBreakChannel(guild);
    const breakChannel = session.breakChannelId
      ? await guild.channels.fetch(session.breakChannelId).catch(() => foundBreak)
      : foundBreak;

    const mentions = Array.from(session.participants)
      .map((id) => `<@${id}>`)
      .join(' ');

    if (studyChannel) {
      // Prevent VoiceStateUpdate or sweep from deleting the channel mid-voice-transfer!
      spawningRooms.add(studyChannel.id);

      const resultEmbed = new EmbedBuilder()
        .setColor(endedEarly ? 0xfee75c : 0x57f287)
        .setTitle(endedEarly ? '🔓 Focus Session Ended' : '🎉 Focus Session Complete!')
        .setDescription(
          endedEarly
            ? `Session ended early${endedByUser ? ` by <@${endedByUser.id}>` : ''}. Moved everyone to **${breakChannel ? breakChannel.name : 'Break Lounge'}**!`
            : `Great job ${mentions}! You completed **${session.durationMinutes} minutes** of focused study in **${studyChannel.name}**. Enjoy your break!`
        );

      if (breakChannel) {
        // 1. Move everyone currently in the Study Room to the Break Lounge FIRST
        for (const [, member] of studyChannel.members) {
          if (!member.user.bot) {
            await member.voice
              .setChannel(breakChannel, 'Focus session ended - moving to Break Lounge')
              .catch((err) => {
                console.error(`Failed to move ${member.user.tag} to Break Lounge:`, err.message);
              });
          }
        }

        // 2. Send completion message in Break Lounge
        await breakChannel
          .send({ content: endedEarly ? undefined : mentions, embeds: [resultEmbed] })
          .catch(() => {});
      } else {
        await studyChannel
          .send({ content: endedEarly ? undefined : mentions, embeds: [resultEmbed] })
          .catch(() => {});
      }

      // 3. Wait 4 full seconds so Discord finishes transferring the voice connection to Break Lounge before deleting the study room!
      if (isDynamicRoom(studyChannel)) {
        setTimeout(async () => {
          spawningRooms.delete(studyChannel.id);
          const refreshed = await guild.channels.fetch(studyChannel.id).catch(() => null);
          if (refreshed && refreshed.members.filter((m) => !m.user.bot).size === 0) {
            dynamicStudyRooms.delete(studyChannel.id);
            await refreshed.delete('Study session ended and room is empty').catch(() => {});
          }
        }, 4000);
      } else {
        spawningRooms.delete(studyChannel.id);
        await setVoiceChannelStatus(studyChannel.id, '');
        await studyChannel.permissionOverwrites
          .edit(guild.roles.everyone, { Connect: null })
          .catch(() => {});
      }
    }
  } catch (err) {
    console.error('Error ending focus session:', err);
  }
}

// Helper: Sweep and delete any empty dynamic study rooms AND recover/finish any sessions across cloud restarts
async function cleanupEmptyStudyRooms() {
  for (const [, guild] of client.guilds.cache) {
    await guild.channels.fetch().catch(() => {});
    for (const [, ch] of guild.channels.cache) {
      if (isDynamicRoom(ch) && !spawningRooms.has(ch.id)) {
        const humanMembers = ch.members.filter((m) => !m.user.bot);
        const humans = humanMembers.size;
        if (humans === 0) {
          if (activeSessions.has(ch.id)) {
            const session = activeSessions.get(ch.id);
            const remainingMs = session.endTime - Date.now();
            if (remainingMs > 15000) {
              for (const userId of session.participants) {
                pausedSessions.set(userId, {
                  remainingMs,
                  originalMinutes: session.durationMinutes,
                });
                lockedUsers.delete(userId);
              }
            }
            clearTimeout(session.timeoutId);
            clearInterval(session.intervalId);
            activeSessions.delete(ch.id);
          }
          pendingRoomTimers.delete(ch.id);
          dynamicStudyRooms.delete(ch.id);
          await ch.delete('Cleaning up empty dynamic study room').catch(() => {});
        } else if (!activeSessions.has(ch.id)) {
          // Check if this room has an active or expired timer message from before a cloud restart!
          try {
            const messages = await ch.messages.fetch({ limit: 10 });
            const lockMsg = messages.find(
              (m) =>
                m.author.id === client.user.id &&
                m.embeds.length > 0 &&
                m.components.length > 0 &&
                m.embeds[0].description &&
                m.embeds[0].description.includes('<t:')
            );
            if (lockMsg) {
              const desc = lockMsg.embeds[0].description;
              const title = lockMsg.embeds[0].title || '';
              const timeMatch = desc.match(/<t:(\d+):R>/);
              const durMatch = title.match(/\((\d+)\s*mins?/i);
              if (timeMatch) {
                const endTimeMs = parseInt(timeMatch[1], 10) * 1000;
                const durationMinutes = durMatch ? parseInt(durMatch[1], 10) : 20;
                const participantIds = new Set(humanMembers.map((m) => m.id));
                const participantNames = humanMembers.map(
                  (m) => m.displayName || m.user.username
                );
                const breakChannel = findBreakChannel(guild);
                const remainingMs = endTimeMs - Date.now();

                for (const uid of participantIds) {
                  lockedUsers.set(uid, ch.id);
                }

                if (remainingMs <= 0) {
                  // Timer already finished during cloud restart -> End session & move to Break Lounge immediately!
                  activeSessions.set(ch.id, {
                    guildId: guild.id,
                    studyChannelId: ch.id,
                    breakChannelId: breakChannel ? breakChannel.id : null,
                    participants: participantIds,
                    participantNames,
                    endTime: endTimeMs,
                    timeoutId: null,
                    intervalId: null,
                    messageId: lockMsg.id,
                    durationMinutes,
                  });
                  await endFocusSession(ch.id, false);
                } else {
                  // Restore active timer seamlessly!
                  const intervalId = setInterval(async () => {
                    const rem = endTimeMs - Date.now();
                    if (rem <= 0) return;
                    const minsLeft = Math.max(1, Math.ceil(rem / 60000));
                    await setVoiceChannelStatus(
                      ch.id,
                      formatStudyStatus(participantNames, minsLeft)
                    );
                  }, 60 * 1000);

                  const timeoutId = setTimeout(() => {
                    endFocusSession(ch.id, false);
                  }, remainingMs);

                  activeSessions.set(ch.id, {
                    guildId: guild.id,
                    studyChannelId: ch.id,
                    breakChannelId: breakChannel ? breakChannel.id : null,
                    participants: participantIds,
                    participantNames,
                    endTime: endTimeMs,
                    timeoutId,
                    intervalId,
                    messageId: lockMsg.id,
                    durationMinutes,
                  });
                  console.log(
                    `🔄 Recovered active session in ${ch.name} (${Math.ceil(remainingMs / 60000)}m left)`
                  );
                }
              }
            }
          } catch {
            // Ignore fetch errors
          }
        }
      }
    }
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // 1. Set the Bot's live status in the member list
  client.user.setPresence({
    status: 'online',
    activities: [
      {
        name: 'Somebody get these nerds out of here',
        type: ActivityType.Custom,
        state: 'Somebody get these nerds out of here',
      },
    ],
  });

  // 2. Set the Bot's Profile "About Me" description automatically via Discord API
  try {
    await rest.patch(Routes.currentApplication(), {
      body: {
        description:
          'someone really sucks at studying and focusing, so i was built to hold them hostage until they finish hehe\n\n' +
          'created by Archygaze',
      },
    });
    console.log('✅ Bot profile "About Me" description updated!');
  } catch (err) {
    console.error('Could not update application description:', err.message);
  }

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    for (const [, guild] of client.guilds.cache) {
      await rest
        .put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands })
        .catch(() => {});
    }
    console.log('✅ Slash commands (/setup-study, /focus alone, /focus together, /unlock) registered!');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }

  await cleanupEmptyStudyRooms();
  setInterval(cleanupEmptyStudyRooms, 15000);
});

// Automatically register slash commands AND create the Study Zone channels whenever the bot is added to a new server!
client.on(Events.GuildCreate, async (guild) => {
  console.log(`🎉 Joined new server: ${guild.name} (${guild.id})`);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
    console.log(`✅ Registered slash commands in new server: ${guild.name}`);
  } catch (err) {
    console.error(`Failed to register commands in ${guild.name}:`, err.message);
  }

  // Auto-create 📚 STUDY ZONE right when added to the server if it doesn't exist yet!
  try {
    await guild.channels.fetch().catch(() => {});
    const existingCategory = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.includes('STUDY ZONE')
    );
    if (!existingCategory) {
      const category = await guild.channels.create({
        name: '📚 STUDY ZONE',
        type: ChannelType.GuildCategory,
      });
      await guild.channels.create({
        name: CREATE_SOLO_NAME,
        type: ChannelType.GuildVoice,
        parent: category.id,
      });
      await guild.channels.create({
        name: CREATE_GROUP_NAME,
        type: ChannelType.GuildVoice,
        parent: category.id,
      });
      await guild.channels.create({
        name: BREAK_CHANNEL_NAME,
        type: ChannelType.GuildVoice,
        parent: category.id,
      });
      console.log(`✅ Auto-created STUDY ZONE channels in ${guild.name}!`);
    }
  } catch (err) {
    console.error(`Could not auto-create study channels in ${guild.name}:`, err.message);
  }
});

// Handle Voice State Updates (Join-to-Create, Pending Timer Auto-Start, Auto-Resume, Hop Prevention, Empty Room Deletion)
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  const guild = newState.guild || oldState.guild;

  // 1. User is locked into an active session and tries to switch to a DIFFERENT voice channel (not disconnecting)
  const lockedStudyChannelId = lockedUsers.get(member.id);
  if (
    lockedStudyChannelId &&
    newState.channelId &&
    newState.channelId !== lockedStudyChannelId &&
    !isGeneratorChannel(newState.channel)
  ) {
    const targetStudyChannel = guild.channels.cache.get(lockedStudyChannelId);
    if (targetStudyChannel && activeSessions.has(lockedStudyChannelId)) {
      await member.voice
        .setChannel(targetStudyChannel, 'Locked in active focus session')
        .catch(() => {});
      await targetStudyChannel
        .send(
          `🚫 <@${member.id}> You're locked into an active focus session! Finish the timer or click **End Session & Unlock Early** first.`
        )
        .catch(() => {});
      return;
    }
  }

  // 2. Check if the channel the user just left is now empty -> Pause session (if active) & delete the room!
  const leftChannel = oldState.channel;
  if (leftChannel && isDynamicRoom(leftChannel) && leftChannel.id !== newState.channelId) {
    const remainingHumans = leftChannel.members.filter((m) => !m.user.bot).size;
    if (remainingHumans === 0) {
      if (activeSessions.has(leftChannel.id)) {
        const session = activeSessions.get(leftChannel.id);
        const remainingMs = session.endTime - Date.now();
        if (remainingMs > 15000) {
          for (const userId of session.participants) {
            pausedSessions.set(userId, {
              remainingMs,
              originalMinutes: session.durationMinutes,
            });
            lockedUsers.delete(userId);
          }
          console.log(
            `💾 Saved paused session (${Math.ceil(remainingMs / 60000)}m left) for user(s): ${Array.from(
              session.participants
            ).join(', ')}`
          );
        } else {
          for (const userId of session.participants) {
            lockedUsers.delete(userId);
          }
        }
        clearTimeout(session.timeoutId);
        clearInterval(session.intervalId);
        activeSessions.delete(leftChannel.id);
      }

      // If endFocusSession is already handling the move & delayed deletion, don't delete mid-transfer!
      if (spawningRooms.has(leftChannel.id)) {
        return;
      }

      pendingRoomTimers.delete(leftChannel.id);
      dynamicStudyRooms.delete(leftChannel.id);
      setTimeout(async () => {
        const refreshed = await guild.channels.fetch(leftChannel.id).catch(() => null);
        if (refreshed && refreshed.members.filter((m) => !m.user.bot).size === 0) {
          await refreshed.delete('Study room is now empty').catch(() => {});
        }
      }, 2500);
    }
  }

  // 3. User joins a Study Room that has an active locked session -> If they aren't a locked-in participant, bounce them out!
  const joinedChannel = newState.channel;
  if (
    joinedChannel &&
    activeSessions.has(joinedChannel.id) &&
    oldState.channelId !== joinedChannel.id
  ) {
    const session = activeSessions.get(joinedChannel.id);
    if (!session.participants.has(member.id)) {
      const breakChannel = findBreakChannel(guild);
      await member.voice
        .setChannel(breakChannel || null, 'Study room is locked in an active focus session')
        .catch(() => {});
      return;
    }
  }

  // 4. User joins a Study Room that has a pending timer from `/focus alone` (when they weren't in voice yet)
  if (joinedChannel && pendingRoomTimers.has(joinedChannel.id)) {
    const pending = pendingRoomTimers.get(joinedChannel.id);
    pendingRoomTimers.delete(joinedChannel.id);
    const breakChannel = findBreakChannel(guild);
    await startFocusSession(
      guild,
      joinedChannel,
      breakChannel,
      pending.durationMs,
      member.user,
      pending.isResumed,
      pending.originalMinutes
    );
    return;
  }

  // 4. User joins "➕ New Solo Study" or "➕ New Group Study" -> Spawn room & auto-continue if they had a paused timer!
  if (joinedChannel && isGeneratorChannel(joinedChannel)) {
    const isSolo = joinedChannel.name.toLowerCase().includes('solo');

    try {
      const spawnedRoom = await spawnStudyRoom(guild, isSolo, joinedChannel.parentId);

      // Move the user into their newly spawned study room
      await member.voice.setChannel(spawnedRoom, 'Spawned study room');

      // Check if this user has an unfinished session from earlier to continue automatically!
      const paused = pausedSessions.get(member.id);
      if (paused && paused.remainingMs > 15000) {
        const breakChannel = findBreakChannel(guild);
        await startFocusSession(
          guild,
          spawnedRoom,
          breakChannel,
          paused.remainingMs,
          member.user,
          true,
          paused.originalMinutes
        );
      } else {
        await spawnedRoom.send(buildPromptPayload(spawnedRoom, isSolo)).catch(() => {});
      }
    } catch (err) {
      console.error('Failed to spawn dynamic study room:', err.message);
    }
  }
});

// Handle Slash Commands & Button Clicks
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // 1. Slash Commands
    if (interaction.isChatInputCommand()) {
      const { commandName, guild } = interaction;
      const member = await guild.members.fetch(interaction.user.id).catch(() => interaction.member);

      if (commandName === 'setup-study') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const existingCategory = guild.channels.cache.find(
          (c) => c.type === ChannelType.GuildCategory && c.name.includes('STUDY ZONE')
        );
        if (existingCategory) {
          const children = guild.channels.cache.filter((c) => c.parentId === existingCategory.id);
          for (const [, ch] of children) {
            await ch.delete('Re-running /setup-study').catch(() => {});
          }
          await existingCategory.delete('Re-running /setup-study').catch(() => {});
        }

        const category = await guild.channels.create({
          name: '📚 STUDY ZONE',
          type: ChannelType.GuildCategory,
        });

        const createSoloChannel = await guild.channels.create({
          name: CREATE_SOLO_NAME,
          type: ChannelType.GuildVoice,
          parent: category.id,
        });

        const createGroupChannel = await guild.channels.create({
          name: CREATE_GROUP_NAME,
          type: ChannelType.GuildVoice,
          parent: category.id,
        });

        const breakChannel = await guild.channels.create({
          name: BREAK_CHANNEL_NAME,
          type: ChannelType.GuildVoice,
          parent: category.id,
        });

        return interaction.editReply(
          `✅ **Dynamic Study Zone Created!**\n\n` +
            `• 📖 <#${createSoloChannel.id}> — Join (or type \`/study alone\` in any chat) to spawn **📖 Study Room #1, #2...**\n` +
            `• 👥 <#${createGroupChannel.id}> — Join (or type \`/study together\` in any chat) to spawn **👥 Study Together #1, #2...**\n` +
            `• ☕ <#${breakChannel.id}> — **Shared Break Lounge** where everyone is moved when their timer finishes!`
        );
      }

      if (commandName === 'study' || commandName === 'focus') {
        const subcommand = interaction.options.getSubcommand(false) || 'alone';
        const isSolo = subcommand === 'alone';
        const minutes = interaction.options.getInteger('minutes');
        const breakChannel = findBreakChannel(guild);

        // Collect any number of @mentioned friends from the 'friends' string option!
        const friendsRaw = interaction.options.getString('friends') || '';
        const mentionedIds = Array.from(friendsRaw.matchAll(/<@!?(\d+)>/g), (m) => m[1]);
        const uniqueFriendIds = [...new Set(mentionedIds)].filter((id) => id !== member.id);

        await interaction.deferReply();

        let targetRoom = member.voice.channel;
        const paused = pausedSessions.get(member.id);

        // Check if user is already in a matching Study Room, or if we need to spawn one & move them in
        const alreadyInMatchingStudyRoom =
          targetRoom &&
          isStudyChannel(targetRoom) &&
          ((isSolo && targetRoom.userLimit === 1) || (!isSolo && targetRoom.userLimit !== 1));

        if (!alreadyInMatchingStudyRoom) {
          targetRoom = await spawnStudyRoom(
            guild,
            isSolo,
            null,
            member.voice.channelId ? 20000 : 60000
          );

          // Move the command user if they are in a voice channel
          if (member.voice.channelId) {
            await member.voice
              .setChannel(targetRoom, `Moved via /study ${subcommand}`)
              .catch((err) => {
                console.error('Failed to move member to study room:', err.message);
              });
          }
        }

        // If /study together had tagged friend(s), move any tagged friends who are in voice into targetRoom too!
        const movedFriends = [];
        const offlineVoiceFriends = [];
        for (const friendId of uniqueFriendIds) {
          const friendMember = await guild.members.fetch(friendId).catch(() => null);
          if (friendMember && !friendMember.user.bot) {
            if (friendMember.voice.channelId) {
              if (friendMember.voice.channelId !== targetRoom.id) {
                await friendMember.voice
                  .setChannel(targetRoom, `Moved with ${member.user.username} via /study together`)
                  .catch(() => {});
              }
              movedFriends.push(`<@${friendId}>`);
            } else {
              offlineVoiceFriends.push(`<@${friendId}>`);
            }
          }
        }

        const friendSummary =
          (movedFriends.length > 0
            ? `\n👥 **Pulled into voice with you:** ${movedFriends.join(', ')}`
            : '') +
          (offlineVoiceFriends.length > 0
            ? `\n🔔 **Invited to join <#${targetRoom.id}>:** ${offlineVoiceFriends.join(', ')} *(hop into voice!)*`
            : '');

        // Check if nobody is in the targetRoom yet (neither caller nor tagged friends were in voice)
        const refreshedRoom = await guild.channels.fetch(targetRoom.id).catch(() => targetRoom);
        const humansInRoom = refreshedRoom.members.filter((m) => !m.user.bot).size;

        if (humansInRoom === 0) {
          if (minutes) {
            pendingRoomTimers.set(targetRoom.id, {
              userId: member.id,
              durationMs: minutes * 60 * 1000,
              originalMinutes: minutes,
              isResumed: false,
            });
            const joinRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setLabel(`Click to Join ${targetRoom.name} (${minutes}m Timer Ready)`)
                .setEmoji('🔊')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://discord.com/channels/${guild.id}/${targetRoom.id}`)
            );
            return interaction.editReply({
              content:
                `✨ Created <#${targetRoom.id}> with your **${minutes}-minute** timer ready!${friendSummary}\n` +
                `Click the button below (or <#${targetRoom.id}>) to connect your voice and lock in:`,
              components: [joinRow],
            });
          } else if (paused && paused.remainingMs > 15000) {
            const minsLeft = Math.max(1, Math.ceil(paused.remainingMs / 60000));
            pendingRoomTimers.set(targetRoom.id, {
              userId: member.id,
              durationMs: paused.remainingMs,
              originalMinutes: paused.originalMinutes,
              isResumed: true,
            });
            const joinRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setLabel(`Click to Join ${targetRoom.name} (Resume ${minsLeft}m)`)
                .setEmoji('🔊')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://discord.com/channels/${guild.id}/${targetRoom.id}`)
            );
            return interaction.editReply({
              content:
                `🔄 Created <#${targetRoom.id}> to resume your **${minsLeft} mins** left!${friendSummary}\n` +
                `Click the button below (or <#${targetRoom.id}>) to hop in and auto-lock:`,
              components: [joinRow],
            });
          } else {
            const promptPayload = buildPromptPayload(targetRoom, isSolo, true);
            await targetRoom.send(buildPromptPayload(targetRoom, isSolo, false)).catch(() => {});
            return interaction.editReply({
              content:
                `✨ Created <#${targetRoom.id}>!${friendSummary}\nClick **🔊 Join ${targetRoom.name}** below (or <#${targetRoom.id}>), then pick your timer:`,
              ...promptPayload,
            });
          }
        }

        // At least 1 person IS in the Study Room voice channel now!
        if (minutes) {
          const res = await startFocusSession(
            guild,
            targetRoom,
            breakChannel,
            minutes * 60 * 1000,
            interaction.user,
            false,
            minutes
          );
          if (!res.ok) {
            return interaction.editReply(`❌ ${res.error}`);
          }
          return interaction.editReply(
            `🔒 Moved to <#${targetRoom.id}> and locked in a **${minutes}-minute** focus session!${friendSummary}`
          );
        } else if (paused && paused.remainingMs > 15000) {
          const res = await startFocusSession(
            guild,
            targetRoom,
            breakChannel,
            paused.remainingMs,
            interaction.user,
            true,
            paused.originalMinutes
          );
          if (!res.ok) {
            return interaction.editReply(`❌ ${res.error}`);
          }
          const minsLeft = Math.max(1, Math.ceil(paused.remainingMs / 60000));
          return interaction.editReply(
            `🔄 Moved to <#${targetRoom.id}> and resumed your previous focus session (**${minsLeft} mins** left)!${friendSummary}`
          );
        } else {
          const promptPayload = buildPromptPayload(targetRoom, isSolo, offlineVoiceFriends.length > 0);
          await targetRoom.send(buildPromptPayload(targetRoom, isSolo, false)).catch(() => {});
          return interaction.editReply({
            content: `✅ Moved into <#${targetRoom.id}>!${friendSummary}\nPick your focus timer below:`,
            ...promptPayload,
          });
        }
      }

      if (commandName === 'unlock') {
        const currentVoice = member.voice.channel;
        const targetChannelId =
          currentVoice && activeSessions.has(currentVoice.id)
            ? currentVoice.id
            : lockedUsers.get(member.id);

        if (!targetChannelId || !activeSessions.has(targetChannelId)) {
          return interaction.reply({
            content: 'ℹ️ You are not in an active focus session right now.',
            flags: MessageFlags.Ephemeral,
          });
        }

        await endFocusSession(targetChannelId, true, interaction.user);
        return interaction.reply('🔓 Focus session ended! Moving to the Break Lounge...');
      }
    }

    // 2. Button Clicks
    if (interaction.isButton()) {
      const { customId, guild } = interaction;
      const member = await guild.members.fetch(interaction.user.id).catch(() => interaction.member);
      const breakChannel = findBreakChannel(guild);

      // Start Focus Button: focus_<minutes>_<channelId>
      if (customId.startsWith('focus_') && !customId.startsWith('focus_unlock')) {
        const parts = customId.split('_');
        const minutes = parseInt(parts[1], 10);
        const targetChannelId = parts[2] || (member.voice && member.voice.channelId);
        const studyChannel = guild.channels.cache.get(targetChannelId);

        if (!studyChannel) {
          return interaction.reply({
            content: '❌ That Study Room no longer exists. Run `/study alone` or `/study together` to create a new one!',
            flags: MessageFlags.Ephemeral,
          });
        }

        // If the user is in another voice channel when clicking the button, move them into the study room first!
        if (member.voice.channelId && member.voice.channelId !== studyChannel.id) {
          await member.voice.setChannel(studyChannel, 'Starting focus session').catch(() => {});
        }

        if (!member.voice.channelId) {
          pendingRoomTimers.set(studyChannel.id, {
            userId: member.id,
            durationMs: minutes * 60 * 1000,
            originalMinutes: minutes,
            isResumed: false,
          });
          const joinRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setLabel(`Click to Join ${studyChannel.name} (${minutes}m Timer Ready)`)
              .setEmoji('🔊')
              .setStyle(ButtonStyle.Link)
              .setURL(`https://discord.com/channels/${guild.id}/${studyChannel.id}`)
          );
          return interaction.reply({
            content: `⏳ **${minutes}-minute** timer is ready! Click below to join <#${studyChannel.id}> and it will lock automatically:`,
            components: [joinRow],
            flags: MessageFlags.Ephemeral,
          });
        }

        await interaction.deferUpdate();
        const res = await startFocusSession(
          guild,
          studyChannel,
          breakChannel,
          minutes * 60 * 1000,
          interaction.user,
          false,
          minutes
        );
        if (!res.ok) {
          await interaction.followUp({
            content: `❌ ${res.error}`,
            flags: MessageFlags.Ephemeral,
          });
        }
        return;
      }

      // Unlock Button: focus_unlock_<channelId>
      if (customId.startsWith('focus_unlock')) {
        const parts = customId.split('_');
        const targetChannelId = parts[2] || (member.voice && member.voice.channelId);
        const session = activeSessions.get(targetChannelId);
        const studyChannel = guild.channels.cache.get(targetChannelId);

        if (!session) {
          if (studyChannel && isDynamicRoom(studyChannel)) {
            await interaction.deferUpdate();
            if (breakChannel) {
              for (const [, m] of studyChannel.members) {
                if (!m.user.bot) {
                  await m.voice.setChannel(breakChannel, 'Session ended').catch(() => {});
                }
              }
            }
            setTimeout(async () => {
              await studyChannel.delete('Study session ended').catch(() => {});
            }, 3500);
            return;
          }
          return interaction.reply({
            content: 'ℹ️ This focus session has already ended.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const isParticipant = session.participants.has(member.id);
        const isAdmin = member.permissions.has(PermissionFlagsBits.MoveMembers);
        if (!isParticipant && !isAdmin) {
          return interaction.reply({
            content: '❌ Only locked-in participants or moderators can unlock an active session!',
            flags: MessageFlags.Ephemeral,
          });
        }

        await interaction.deferUpdate();
        await endFocusSession(targetChannelId, true, interaction.user);
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const errorMsg =
      err.code === 50013
        ? '❌ **Missing Bot Permissions in this server!**\nPlease ask a server admin to go to **Server Settings → Roles → `ILoveStudying`** (or assign a role to `ILoveStudying`) and turn ON:\n• **Administrator** *(easiest)*\n— OR —\n• **Manage Channels**, **Manage Roles**, and **Move Members**!'
        : `❌ Error: ${err.message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: errorMsg }).catch(() => {});
    } else if (interaction.isRepliable()) {
      await interaction
        .reply({ content: errorMsg, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);

// Optional lightweight health-check server for free cloud hosts (Render / Koyeb)
if (process.env.PORT) {
  const http = require('http');
  http
    .createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Discord Study Bot is alive!');
    })
    .listen(process.env.PORT, () => {
      console.log(`🌐 Health-check server listening on port ${process.env.PORT}`);
    });
}
