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
    .setName('focus')
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
        .setDescription('Create & move into a Group Study Room (or lock your current room)')
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
    permissionOverwrites: [
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.MoveMembers,
        ],
      },
    ],
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
        `Select a timer below (or type \`/focus alone\` / \`/focus together\`) to **start & lock in**:\n` +
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

  try {
    // 1. Ensure the bot itself keeps Connect/View/Send/Manage permissions before locking @everyone
    await studyChannel.permissionOverwrites
      .edit(client.user.id, {
        ViewChannel: true,
        Connect: true,
        SendMessages: true,
        ManageChannels: true,
        MoveMembers: true,
      })
      .catch(() => {});

    // 2. Grant Connect to locked-in participants BEFORE denying @everyone
    for (const userId of participantIds) {
      await studyChannel.permissionOverwrites
        .edit(userId, {
          Connect: true,
        })
        .catch(() => {});
      lockedUsers.set(userId, studyChannel.id);
      pausedSessions.delete(userId);
    }

    // 3. Lock the channel for @everyone so outsiders cannot connect
    await studyChannel.permissionOverwrites.edit(guild.roles.everyone, {
      Connect: false,
    });
  } catch (err) {
    console.error('Permission error while locking Study Room:', err.message);
    for (const userId of participantIds) {
      lockedUsers.delete(userId);
    }
    return {
      ok: false,
      error:
        'Missing Discord permissions to lock the channel! Make sure the bot role has **Administrator** in Server Settings → Roles.',
    };
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
      await setVoiceChannelStatus(studyChannel.id, '');

      await studyChannel.permissionOverwrites
        .edit(guild.roles.everyone, {
          Connect: null,
        })
        .catch(() => {});

      for (const userId of session.participants) {
        await studyChannel.permissionOverwrites.delete(userId).catch(() => {});
      }

      if (session.messageId) {
        const oldMsg = await studyChannel.messages.fetch(session.messageId).catch(() => null);
        if (oldMsg) {
          await oldMsg.edit({ components: [] }).catch(() => {});
        }
      }

      const resultEmbed = new EmbedBuilder()
        .setColor(endedEarly ? 0xfee75c : 0x57f287)
        .setTitle(endedEarly ? '🔓 Focus Session Ended' : '🎉 Focus Session Complete!')
        .setDescription(
          endedEarly
            ? `Session ended early${endedByUser ? ` by <@${endedByUser.id}>` : ''}. Moving everyone to **${breakChannel ? breakChannel.name : 'Break Lounge'}**!`
            : `Great job ${mentions}! You completed **${session.durationMinutes} minutes** of focused study in **${studyChannel.name}**. Enjoy your break!`
        );

      if (breakChannel) {
        await breakChannel
          .send({ content: endedEarly ? undefined : mentions, embeds: [resultEmbed] })
          .catch(() => {});

        // Move everyone currently in the Study Room to the Break Lounge
        for (const [, member] of studyChannel.members) {
          if (!member.user.bot) {
            await member.voice
              .setChannel(breakChannel, 'Focus session ended - moving to Break Lounge')
              .catch((err) => {
                console.error(`Failed to move ${member.user.tag} to Break Lounge:`, err.message);
              });
          }
        }
      } else {
        await studyChannel
          .send({ content: endedEarly ? undefined : mentions, embeds: [resultEmbed] })
          .catch(() => {});
      }

      // Delete the finished study room once everyone is moved out
      if (isDynamicRoom(studyChannel)) {
        setTimeout(async () => {
          const refreshed = await guild.channels.fetch(studyChannel.id).catch(() => null);
          if (refreshed && refreshed.members.filter((m) => !m.user.bot).size === 0) {
            dynamicStudyRooms.delete(studyChannel.id);
            await refreshed.delete('Study session ended and room is empty').catch(() => {});
          }
        }, 1500);
      }
    }
  } catch (err) {
    console.error('Error ending focus session:', err);
  }
}

// Helper: Sweep and delete any empty dynamic study rooms in all guilds
async function cleanupEmptyStudyRooms() {
  for (const [, guild] of client.guilds.cache) {
    await guild.channels.fetch().catch(() => {});
    for (const [, ch] of guild.channels.cache) {
      if (isDynamicRoom(ch) && !spawningRooms.has(ch.id)) {
        const humans = ch.members.filter((m) => !m.user.bot).size;
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
        name: '📚 /focus alone • Lock in & Study!',
        type: ActivityType.Custom,
        state: '📚 /focus alone • Lock in & Study!',
      },
    ],
  });

  // 2. Set the Bot's Profile "About Me" description automatically via Discord API
  try {
    await rest.patch(Routes.currentApplication(), {
      body: {
        description: 'someone really sucks at studying and focus so im here to help hehe',
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

      pendingRoomTimers.delete(leftChannel.id);
      dynamicStudyRooms.delete(leftChannel.id);
      await leftChannel.delete('Study room is now empty').catch(() => {});
    }
  }

  // 3. User joins a Study Room that has a pending timer from `/focus alone` (when they weren't in voice yet)
  const joinedChannel = newState.channel;
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
            `• 📖 <#${createSoloChannel.id}> — Join (or type \`/focus alone\` in any chat) to spawn **📖 Study Room #1, #2...**\n` +
            `• 👥 <#${createGroupChannel.id}> — Join (or type \`/focus together\` in any chat) to spawn **👥 Study Together #1, #2...**\n` +
            `• ☕ <#${breakChannel.id}> — **Shared Break Lounge** where everyone is moved when their timer finishes!`
        );
      }

      if (commandName === 'focus') {
        const subcommand = interaction.options.getSubcommand(false) || 'alone';
        const isSolo = subcommand === 'alone';
        const minutes = interaction.options.getInteger('minutes');
        const breakChannel = findBreakChannel(guild);

        await interaction.deferReply();

        let targetRoom = member.voice.channel;
        const paused = pausedSessions.get(member.id);

        // Check if user is already in a matching Study Room, or if we need to spawn one & move them in
        const alreadyInMatchingStudyRoom =
          targetRoom &&
          isStudyChannel(targetRoom) &&
          ((isSolo && targetRoom.userLimit === 1) || (!isSolo && targetRoom.userLimit !== 1));

        if (!alreadyInMatchingStudyRoom) {
          // Give 60s grace period if the user isn't connected to voice yet so they can click the room
          targetRoom = await spawnStudyRoom(guild, isSolo, null, member.voice.channelId ? 20000 : 60000);

          // If the user is currently in ANY voice channel (like Break Lounge or General), move them straight into the new Study Room!
          if (member.voice.channelId) {
            await member.voice
              .setChannel(targetRoom, `Moved via /focus ${subcommand}`)
              .catch((err) => {
                console.error('Failed to move member to study room:', err.message);
              });
          } else {
            // Discord does not allow any bot to turn on a user's mic if they aren't connected to a voice channel yet.
            // So we queue their timer and give them a 1-click Join Voice button!
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
                  `✨ Created <#${targetRoom.id}> with your **${minutes}-minute** timer ready!\n` +
                  `*(Discord requires you to be in a voice channel before a bot can move you — click the button below or <#${targetRoom.id}> and your timer will lock in automatically!)*`,
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
                  `🔄 Created <#${targetRoom.id}> to resume your **${minsLeft} mins** left!\n` +
                  `Click the button below (or <#${targetRoom.id}>) to hop in and auto-lock:`,
                components: [joinRow],
              });
            } else {
              const promptPayload = buildPromptPayload(targetRoom, isSolo, true);
              await targetRoom.send(buildPromptPayload(targetRoom, isSolo, false)).catch(() => {});
              return interaction.editReply({
                content:
                  `✨ Created <#${targetRoom.id}> for you! Click **🔊 Join ${targetRoom.name}** below (or <#${targetRoom.id}>), then pick your timer:`,
                ...promptPayload,
              });
            }
          }
        }

        // User IS in the voice channel now!
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
            `🔒 Moved you to <#${targetRoom.id}> and locked in a **${minutes}-minute** focus session!`
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
            `🔄 Moved you to <#${targetRoom.id}> and resumed your previous focus session (**${minsLeft} mins** left)!`
          );
        } else {
          const promptPayload = buildPromptPayload(targetRoom, isSolo, false);
          await targetRoom.send(promptPayload).catch(() => {});
          return interaction.editReply({
            content: `✅ Moved you into <#${targetRoom.id}>! Pick your focus timer below:`,
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
            content: '❌ That Study Room no longer exists. Run `/focus alone` to create a new one!',
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

        if (!session) {
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
