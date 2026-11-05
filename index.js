require('dotenv').config();
const {
  Client,
  Events,
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

// Track dynamically spawned study rooms so they auto-delete when empty
// Set<channelId>
const dynamicStudyRooms = new Set();

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
    .setDescription('Start a locked focus session in your current Study Room')
    .addIntegerOption((opt) =>
      opt
        .setName('minutes')
        .setDescription('Focus duration in minutes (e.g. 20, 30, 60)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(240)
    ),
  new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('End the focus session in your current Study Room early'),
].map((cmd) => cmd.toJSON());

// Helper: Check if a channel is a "Join-to-Create" generator channel
function isGeneratorChannel(channel) {
  if (!channel || channel.type !== ChannelType.GuildVoice) return false;
  const name = channel.name.toLowerCase();
  return name.includes('➕') || name.includes('new solo') || name.includes('new group');
}

// Helper: Check if a channel is an active/spawned Study Room (not a generator)
function isStudyChannel(channel) {
  if (!channel || channel.type !== ChannelType.GuildVoice) return false;
  if (isGeneratorChannel(channel)) return false;
  if (dynamicStudyRooms.has(channel.id)) return true;
  const name = channel.name.toLowerCase();
  return name.includes('study') || name.includes('🎧') || name.includes('👥') || name.includes('📖');
}

// Helper: Check if a dynamic room should auto-delete when empty
function isDynamicRoom(channel) {
  if (!channel || channel.type !== ChannelType.GuildVoice) return false;
  if (isGeneratorChannel(channel)) return false;
  if (dynamicStudyRooms.has(channel.id)) return true;
  return (
    channel.name.includes('Study Room #') ||
    channel.name.includes('Study Together #') ||
    channel.name.includes("'s Study")
  );
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
  return guild.channels.cache.find(
    (ch) =>
      ch.type === ChannelType.GuildVoice &&
      (ch.id === process.env.BREAK_CHANNEL_ID ||
        ch.name.toLowerCase().includes('break') ||
        ch.name.toLowerCase().includes('lounge') ||
        ch.name === BREAK_CHANNEL_NAME)
  );
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
function buildPromptPayload(studyChannel, isSolo) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(isSolo ? `📖 ${studyChannel.name} (Solo)` : `👥 ${studyChannel.name} (Group)`)
    .setDescription(
      `Welcome to **${studyChannel.name}**!\n` +
        (isSolo
          ? `This is a **1-person** study room.\n\n`
          : `Invite your friends to join this channel first, then pick a timer to lock everyone in!\n\n`) +
        `Select a timer below (or type \`/focus <minutes>\`) to **start & lock in**:\n` +
        `• 🔒 **Room Locks:** Nobody else can enter while the timer runs.\n` +
        `• 💬 **Live Status:** Sets the channel status to \`[Username] is studying • Xm left\`.\n` +
        `• 🚫 **No Channel Hopping:** Switching channels pulls you right back here.\n` +
        `• ☕ **Auto-Break:** Moves everyone to **${BREAK_CHANNEL_NAME}** & cleans up the room when done!`
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

  return { embeds: [embed], components: [row] };
}

// Start a locked study session in a specific studyChannel
async function startFocusSession(guild, studyChannel, breakChannel, durationMinutes, starterUser) {
  if (activeSessions.has(studyChannel.id)) {
    return { ok: false, error: 'A focus session is already running in this room!' };
  }

  const membersInRoom = Array.from(studyChannel.members.values()).filter((m) => !m.user.bot);
  if (membersInRoom.length === 0) {
    return { ok: false, error: 'You must be inside the Study Room voice channel to start a session!' };
  }

  const participantIds = new Set(membersInRoom.map((m) => m.id));
  const participantNames = membersInRoom.map((m) => m.displayName || m.user.username);

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

  const endTimeMs = Date.now() + durationMinutes * 60 * 1000;
  const endTimestampSec = Math.floor(endTimeMs / 1000);

  // 4. Set the Voice Channel Status immediately ("🔒 username is studying • 20m left")
  await setVoiceChannelStatus(
    studyChannel.id,
    formatStudyStatus(participantNames, durationMinutes)
  );

  // Update the Voice Channel Status every minute as the timer counts down
  const intervalId = setInterval(async () => {
    const remainingMs = endTimeMs - Date.now();
    if (remainingMs <= 0) return;
    const minsLeft = Math.max(1, Math.ceil(remainingMs / 60000));
    await setVoiceChannelStatus(studyChannel.id, formatStudyStatus(participantNames, minsLeft));
  }, 60 * 1000);

  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`🔒 Focus Session Locked (${durationMinutes} mins)`)
    .setDescription(
      `Started by <@${starterUser.id}> in **${studyChannel.name}**\n\n` +
        `💬 **Channel Status:** \`${formatStudyStatus(participantNames, durationMinutes)}\`\n` +
        `⏳ **Ends:** <t:${endTimestampSec}:R> (at <t:${endTimestampSec}:t>)\n` +
        `👥 **Locked-in:** ${Array.from(participantIds)
          .map((id) => `<@${id}>`)
          .join(', ')}\n\n` +
        `*This room is now locked to outsiders. Stay focused!*`
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
  }, durationMinutes * 60 * 1000);

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
    durationMinutes,
  });

  return { ok: true };
}

// End a study session, move members to the single Break Lounge, and clean up dynamic room if empty
async function endFocusSession(studyChannelId, endedEarly = false, endedByUser = null) {
  const session = activeSessions.get(studyChannelId);
  if (!session) return;

  clearTimeout(session.timeoutId);
  clearInterval(session.intervalId);
  activeSessions.delete(studyChannelId);

  for (const userId of session.participants) {
    lockedUsers.delete(userId);
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
      // 1. Clear the Voice Channel Status
      await setVoiceChannelStatus(studyChannel.id, '');

      // 2. Unlock @everyone Connect permission
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

      if (endedEarly) {
        const earlyEmbed = new EmbedBuilder()
          .setColor(0xfee75c)
          .setTitle('🔓 Focus Session Ended Early')
          .setDescription(
            `Session unlocked early${endedByUser ? ` by <@${endedByUser.id}>` : ''}. **${studyChannel.name}** is now unlocked!`
          );
        await studyChannel.send({ embeds: [earlyEmbed] }).catch(() => {});
      } else {
        // Timer completed naturally -> Move everyone to Break Lounge & notify in Break Lounge
        const doneEmbed = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle('🎉 Focus Session Complete!')
          .setDescription(
            `Great job ${mentions}! You completed **${session.durationMinutes} minutes** of focused study in **${studyChannel.name}**. Enjoy your break!`
          );

        if (breakChannel) {
          await breakChannel
            .send({ content: mentions, embeds: [doneEmbed] })
            .catch(() => {});

          for (const [, member] of studyChannel.members) {
            if (!member.user.bot) {
              await member.voice
                .setChannel(breakChannel, 'Focus session completed')
                .catch(() => {});
            }
          }
        } else {
          await studyChannel
            .send({ content: mentions, embeds: [doneEmbed] })
            .catch(() => {});
        }

        // Delete the temporary study room if it is a dynamic room and now empty
        if (isDynamicRoom(studyChannel)) {
          setTimeout(async () => {
            const refreshed = await guild.channels.fetch(studyChannel.id).catch(() => null);
            if (refreshed && refreshed.members.filter((m) => !m.user.bot).size === 0) {
              dynamicStudyRooms.delete(studyChannel.id);
              await refreshed.delete('Study session completed and room is empty').catch(() => {});
            }
          }, 1500);
        }
      }
    }
  } catch (err) {
    console.error('Error ending focus session:', err);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash commands (/setup-study, /focus, /unlock) registered!');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }

  // Clean up or rename any leftover "'s Study" channels from earlier
  for (const [, guild] of client.guilds.cache) {
    for (const [, ch] of guild.channels.cache) {
      if (ch.type === ChannelType.GuildVoice && ch.name.includes("'s Study")) {
        const humans = ch.members.filter((m) => !m.user.bot).size;
        if (humans === 0) {
          await ch.delete('Cleaning up empty dynamic study room').catch(() => {});
        } else {
          const isSolo = ch.userLimit === 1;
          const newName = getNextRoomName(guild, isSolo);
          dynamicStudyRooms.add(ch.id);
          await ch.setName(newName).catch(() => {});
        }
      }
    }
  }
});

// Handle Voice State Updates (Join-to-Create, Locked-in Hop Prevention, Empty Room Cleanup)
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  const guild = newState.guild || oldState.guild;

  // 1. User is locked into an active session and tries to switch to ANY other voice channel
  const lockedStudyChannelId = lockedUsers.get(member.id);
  if (
    lockedStudyChannelId &&
    newState.channelId &&
    newState.channelId !== lockedStudyChannelId
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

  // 2. User joins "➕ New Solo Study" or "➕ New Group Study" -> Spawn "📖 Study Room #1" or "👥 Study Together #1"
  const joinedChannel = newState.channel;
  if (joinedChannel && isGeneratorChannel(joinedChannel)) {
    const isSolo = joinedChannel.name.toLowerCase().includes('solo');
    const roomName = getNextRoomName(guild, isSolo);

    try {
      const spawnedRoom = await guild.channels.create({
        name: roomName,
        type: ChannelType.GuildVoice,
        parent: joinedChannel.parentId,
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

      // Move the user into their newly spawned study room
      await member.voice.setChannel(spawnedRoom, 'Spawned study room');

      // Send the timer buttons inside the new study room's voice chat
      await spawnedRoom.send(buildPromptPayload(spawnedRoom, isSolo)).catch(() => {});
    } catch (err) {
      console.error('Failed to spawn dynamic study room:', err.message);
    }
    return;
  }

  // 3. Clean up empty dynamic study rooms when everyone leaves
  const leftChannel = oldState.channel;
  if (leftChannel && isDynamicRoom(leftChannel) && leftChannel.id !== newState.channelId) {
    const remainingHumans = leftChannel.members.filter((m) => !m.user.bot).size;
    if (remainingHumans === 0) {
      if (activeSessions.has(leftChannel.id)) {
        const session = activeSessions.get(leftChannel.id);
        clearTimeout(session.timeoutId);
        clearInterval(session.intervalId);
        for (const userId of session.participants) {
          lockedUsers.delete(userId);
        }
        activeSessions.delete(leftChannel.id);
      }
      dynamicStudyRooms.delete(leftChannel.id);
      await leftChannel.delete('Dynamic study room is empty').catch(() => {});
    }
  }
});

// Handle Slash Commands & Button Clicks
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // 1. Slash Commands
    if (interaction.isChatInputCommand()) {
      const { commandName, guild, member } = interaction;

      if (commandName === 'setup-study') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Clean up previous STUDY ZONE category & channels if re-running /setup-study
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

        // 1. Join-to-Create Solo Study Room
        const createSoloChannel = await guild.channels.create({
          name: CREATE_SOLO_NAME,
          type: ChannelType.GuildVoice,
          parent: category.id,
        });

        // 2. Join-to-Create Group Study Room
        const createGroupChannel = await guild.channels.create({
          name: CREATE_GROUP_NAME,
          type: ChannelType.GuildVoice,
          parent: category.id,
        });

        // 3. Single shared Break Lounge
        const breakChannel = await guild.channels.create({
          name: BREAK_CHANNEL_NAME,
          type: ChannelType.GuildVoice,
          parent: category.id,
        });

        return interaction.editReply(
          `✅ **Dynamic Study Zone Created!**\n\n` +
            `• 📖 <#${createSoloChannel.id}> — Join to spawn **📖 Study Room #1, #2...** (1-person room)\n` +
            `• 👥 <#${createGroupChannel.id}> — Join to spawn **👥 Study Together #1, #2...** (Group room)\n` +
            `• ☕ <#${breakChannel.id}> — **Shared Break Lounge** where everyone is moved when their timer finishes!`
        );
      }

      if (commandName === 'focus') {
        const minutes = interaction.options.getInteger('minutes');
        const currentVoice = member.voice.channel;

        if (!currentVoice || !isStudyChannel(currentVoice)) {
          return interaction.reply({
            content:
              '❌ Join **➕ New Solo Study** or **➕ New Group Study** first to spawn a Study Room!',
            flags: MessageFlags.Ephemeral,
          });
        }

        const breakChannel = findBreakChannel(guild);
        await interaction.deferReply();
        const res = await startFocusSession(
          guild,
          currentVoice,
          breakChannel,
          minutes,
          interaction.user
        );
        if (!res.ok) {
          return interaction.editReply(`❌ ${res.error}`);
        }
        return interaction.editReply(
          `🔒 Focus session started in <#${currentVoice.id}> for **${minutes} minutes**!`
        );
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
        return interaction.reply('🔓 Focus session ended and room unlocked!');
      }
    }

    // 2. Button Clicks
    if (interaction.isButton()) {
      const { customId, guild, member } = interaction;
      const breakChannel = findBreakChannel(guild);

      // Start Focus Button: focus_<minutes>_<channelId>
      if (customId.startsWith('focus_') && !customId.startsWith('focus_unlock')) {
        const parts = customId.split('_');
        const minutes = parseInt(parts[1], 10);
        const targetChannelId = parts[2] || (member.voice && member.voice.channelId);
        const studyChannel = guild.channels.cache.get(targetChannelId);

        if (!studyChannel || member.voice.channelId !== studyChannel.id) {
          return interaction.reply({
            content: `❌ You must be inside <#${targetChannelId}> to start its timer!`,
            flags: MessageFlags.Ephemeral,
          });
        }

        await interaction.deferUpdate();
        const res = await startFocusSession(
          guild,
          studyChannel,
          breakChannel,
          minutes,
          interaction.user
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
