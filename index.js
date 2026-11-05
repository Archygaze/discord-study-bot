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

// Channel naming conventions
const GROUP_STUDY_NAME = '👥 Study Together';
const SOLO_STUDY_1_NAME = '🎧 Solo Study 1';
const SOLO_STUDY_2_NAME = '🎧 Solo Study 2';
const BREAK_CHANNEL_NAME = process.env.BREAK_CHANNEL_NAME || '☕ Break Lounge';

const commands = [
  new SlashCommandBuilder()
    .setName('setup-study')
    .setDescription('Creates Study Together, Solo Study 1 & 2, and one Break Lounge')
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

// Helper: Check if a voice channel is a Study Room
function isStudyChannel(channel) {
  if (!channel || channel.type !== ChannelType.GuildVoice) return false;
  const name = channel.name.toLowerCase();
  return name.includes('study');
}

// Helper: Find all Study Rooms and the single Break Lounge in a guild
function findStudyChannels(guild) {
  const studyChannels = guild.channels.cache.filter((ch) => isStudyChannel(ch));

  const breakChannel = guild.channels.cache.find(
    (ch) =>
      ch.type === ChannelType.GuildVoice &&
      (ch.id === process.env.BREAK_CHANNEL_ID ||
        ch.name.toLowerCase().includes('break') ||
        ch.name.toLowerCase().includes('lounge') ||
        ch.name === BREAK_CHANNEL_NAME)
  );

  return { studyChannels, breakChannel };
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
  return text.slice(0, 480); // Discord max status length is 500 chars
}

// Build the prompt message with duration buttons
function buildPromptPayload(studyChannel) {
  const isSolo = studyChannel.userLimit === 1 || studyChannel.name.toLowerCase().includes('solo');
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(isSolo ? '🎧 Solo Focus Room' : '👥 Group Focus Room')
    .setDescription(
      `Welcome to **${studyChannel.name}**!\n\n` +
        `Select a timer below (or use \`/focus <minutes>\`) to **lock this room** and start your focus session:\n` +
        `• 🔒 **Room Locks:** Nobody else can join this room while the timer is active.\n` +
        `• 💬 **Live Channel Status:** Shows \`[Your Name] is studying • Xm left\` under the channel.\n` +
        `• 🚫 **No Channel Hopping:** Switching to another voice channel will pull you right back here.\n` +
        `• ☕ **Auto-Break:** When time is up, moves you to **${BREAK_CHANNEL_NAME}**!`
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
    // 1. Ensure the bot itself keeps Connect/View/Send/Status permissions before locking @everyone!
    const botAllowPerms = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.Connect,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.MoveMembers,
    ];
    if (PermissionFlagsBits.SetVoiceChannelStatus) {
      botAllowPerms.push(PermissionFlagsBits.SetVoiceChannelStatus);
    }

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
        'Missing Discord permissions to lock the channel! Make sure the bot role has **Administrator** (or Connect + Manage Channels + Manage Roles + Set Voice Channel Status) in Server Settings → Roles.',
    };
  }

  const endTimeMs = Date.now() + durationMinutes * 60 * 1000;
  const endTimestampSec = Math.floor(endTimeMs / 1000);

  // 4. Set the Voice Channel Status immediately
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

// End a study session, clear status, unlock permissions, and move members to the single Break Lounge
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
    const { breakChannel: foundBreak } = findStudyChannels(guild);
    const breakChannel = session.breakChannelId
      ? await guild.channels.fetch(session.breakChannelId).catch(() => foundBreak)
      : foundBreak;

    if (studyChannel) {
      // 1. Clear the Voice Channel Status
      await setVoiceChannelStatus(studyChannel.id, '');

      // 2. Unlock @everyone Connect permission
      await studyChannel.permissionOverwrites
        .edit(guild.roles.everyone, {
          Connect: null,
        })
        .catch(() => {});

      // Clean up individual participant overwrites
      for (const userId of session.participants) {
        await studyChannel.permissionOverwrites.delete(userId).catch(() => {});
      }

      // Disable the early-unlock button on the session message
      if (session.messageId) {
        const oldMsg = await studyChannel.messages.fetch(session.messageId).catch(() => null);
        if (oldMsg) {
          await oldMsg.edit({ components: [] }).catch(() => {});
        }
      }

      // 3. Notify participants
      const mentions = Array.from(session.participants)
        .map((id) => `<@${id}>`)
        .join(' ');

      const doneEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle(endedEarly ? '🔓 Focus Session Ended Early' : '🎉 Focus Session Complete!')
        .setDescription(
          endedEarly
            ? `Session unlocked early${endedByUser ? ` by <@${endedByUser.id}>` : ''}. **${studyChannel.name}** is now open!`
            : `Great job ${mentions}! You completed **${session.durationMinutes} minutes** of focused study.\n` +
                (breakChannel
                  ? `Moving you to **${breakChannel.name}** for a well-deserved break!`
                  : `The room is now unlocked!`)
        );

      await studyChannel
        .send({ content: endedEarly ? undefined : mentions, embeds: [doneEmbed] })
        .catch(() => {});

      // 4. Move everyone currently in this Study Room to the single Break Lounge
      if (!endedEarly && breakChannel) {
        for (const [, member] of studyChannel.members) {
          if (!member.user.bot) {
            await member.voice.setChannel(breakChannel, 'Focus session completed').catch(() => {});
          }
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

  // Ensure any study channels left locked from a previous restart are unlocked and status cleared
  for (const [, guild] of client.guilds.cache) {
    const { studyChannels } = findStudyChannels(guild);
    for (const [, studyChannel] of studyChannels) {
      if (!activeSessions.has(studyChannel.id)) {
        await studyChannel.permissionOverwrites
          .edit(guild.roles.everyone, { Connect: null })
          .catch(() => {});
        await setVoiceChannelStatus(studyChannel.id, '');
      }
    }
  }
});

// Handle Voice State Updates (Joining, Leaving, or trying to hop channels)
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  const guild = newState.guild || oldState.guild;

  // Case 1: User is locked into an active session and tries to switch to ANY other voice channel
  const lockedStudyChannelId = lockedUsers.get(member.id);
  if (
    lockedStudyChannelId &&
    newState.channelId &&
    newState.channelId !== lockedStudyChannelId
  ) {
    const targetStudyChannel = guild.channels.cache.get(lockedStudyChannelId);
    if (targetStudyChannel && activeSessions.has(lockedStudyChannelId)) {
      // Pull them right back into their Study Room!
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

  // Case 2: User joins any Study Room when no session is active in that room -> Send timer buttons
  const joinedChannel = newState.channel;
  if (
    joinedChannel &&
    isStudyChannel(joinedChannel) &&
    oldState.channelId !== joinedChannel.id
  ) {
    if (!activeSessions.has(joinedChannel.id)) {
      const humanCount = joinedChannel.members.filter((m) => !m.user.bot).size;
      // Send prompt when the first person enters this unlocked Study Room
      if (humanCount === 1) {
        await joinedChannel.send(buildPromptPayload(joinedChannel)).catch((err) => {
          console.error('Could not send prompt to study channel:', err.message);
        });
      }
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

        // Remove old Study Zone channels if re-running /setup-study so there are no duplicates
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

        const botOverwrite = {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.MoveMembers,
          ],
        };

        const category = await guild.channels.create({
          name: '📚 STUDY ZONE',
          type: ChannelType.GuildCategory,
        });

        // 1. Group Study Room (Unlimited users)
        const groupChannel = await guild.channels.create({
          name: GROUP_STUDY_NAME,
          type: ChannelType.GuildVoice,
          parent: category.id,
          permissionOverwrites: [botOverwrite],
        });

        // 2. Solo Study 1 (1-person room)
        const solo1Channel = await guild.channels.create({
          name: SOLO_STUDY_1_NAME,
          type: ChannelType.GuildVoice,
          parent: category.id,
          userLimit: 1,
          permissionOverwrites: [botOverwrite],
        });

        // 3. Solo Study 2 (1-person room)
        const solo2Channel = await guild.channels.create({
          name: SOLO_STUDY_2_NAME,
          type: ChannelType.GuildVoice,
          parent: category.id,
          userLimit: 1,
          permissionOverwrites: [botOverwrite],
        });

        // 4. Single shared Break Lounge
        const breakChannel = await guild.channels.create({
          name: BREAK_CHANNEL_NAME,
          type: ChannelType.GuildVoice,
          parent: category.id,
        });

        return interaction.editReply(
          `✅ **Study Zone Created!**\n` +
            `• 👥 **Group Room:** <#${groupChannel.id}> (Study together with friends)\n` +
            `• 🎧 **Solo Room 1:** <#${solo1Channel.id}> (1-person room)\n` +
            `• 🎧 **Solo Room 2:** <#${solo2Channel.id}> (1-person room)\n` +
            `• ☕ **Shared Break Lounge:** <#${breakChannel.id}> (All study rooms move you here when finished!)`
        );
      }

      if (commandName === 'focus') {
        const minutes = interaction.options.getInteger('minutes');
        const currentVoice = member.voice.channel;

        if (!currentVoice || !isStudyChannel(currentVoice)) {
          return interaction.reply({
            content: '❌ Join one of the **Study Rooms** first before starting a focus session!',
            flags: MessageFlags.Ephemeral,
          });
        }

        const { breakChannel } = findStudyChannels(guild);
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
      const { breakChannel } = findStudyChannels(guild);

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
