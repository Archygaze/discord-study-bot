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

// Prevent unhandled errors from crashing the bot process
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

// Active study sessions per voice channel ID
// Map<channelId, { guildId, studyChannelId, breakChannelId, participants: Set<userId>, endTime, timeoutId, messageId, durationMinutes }>
const activeSessions = new Map();

// Track which user is locked into which study channel for instant move-back enforcement
// Map<userId, studyChannelId>
const lockedUsers = new Map();

// Default channel names (can be overridden in .env or created automatically with /setup-study)
const STUDY_CHANNEL_NAME = process.env.STUDY_CHANNEL_NAME || '📖 Study Room';
const BREAK_CHANNEL_NAME = process.env.BREAK_CHANNEL_NAME || '☕ Break Lounge';

const commands = [
  new SlashCommandBuilder()
    .setName('setup-study')
    .setDescription('Automatically creates the Study Room and Break Lounge voice channels')
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
    .setDescription('End the current focus session early and unlock the Study Room'),
].map((cmd) => cmd.toJSON());

// Helper: Find Study Room and Break Lounge in a guild
function findStudyChannels(guild) {
  const studyChannel = guild.channels.cache.find(
    (ch) =>
      ch.type === ChannelType.GuildVoice &&
      (ch.id === process.env.STUDY_CHANNEL_ID ||
        ch.name.toLowerCase().includes('study room') ||
        ch.name === STUDY_CHANNEL_NAME)
  );

  const breakChannel = guild.channels.cache.find(
    (ch) =>
      ch.type === ChannelType.GuildVoice &&
      (ch.id === process.env.BREAK_CHANNEL_ID ||
        ch.name.toLowerCase().includes('break') ||
        ch.name.toLowerCase().includes('lounge') ||
        ch.name === BREAK_CHANNEL_NAME)
  );

  return { studyChannel, breakChannel };
}

// Build the prompt message with duration buttons
function buildPromptPayload(studyChannel) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎓 Ready to Focus?')
    .setDescription(
      `Welcome to **${studyChannel.name}**!\n\n` +
        `Select a timer below (or use \`/focus <minutes>\`) to **lock the room** and start your focus session:\n` +
        `• 🔒 **Room Locks:** Nobody else can join while the timer is active.\n` +
        `• 🚫 **No Channel Hopping:** Switching to another voice channel will pull you right back here.\n` +
        `• ☕ **Auto-Break:** When time is up, the room unlocks and moves everyone to the Break Lounge!`
    )
    .setFooter({ text: 'Choose a focus duration below to lock in' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('focus_20')
      .setLabel('20 Min')
      .setEmoji('🍅')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('focus_30')
      .setLabel('30 Min')
      .setEmoji('⏱️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('focus_60')
      .setLabel('60 Min')
      .setEmoji('🔥')
      .setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row] };
}

// Start a locked study session
async function startFocusSession(guild, studyChannel, breakChannel, durationMinutes, starterUser) {
  if (activeSessions.has(studyChannel.id)) {
    return { ok: false, error: 'A focus session is already running in this room!' };
  }

  const membersInRoom = Array.from(studyChannel.members.values()).filter((m) => !m.user.bot);
  if (membersInRoom.length === 0) {
    return { ok: false, error: 'You must be inside the Study Room voice channel to start a session!' };
  }

  const participantIds = new Set(membersInRoom.map((m) => m.id));

  try {
    // 1. Ensure the bot itself keeps Connect/View/Send permissions before locking @everyone!
    // (In Discord, denying Connect on @everyone also locks out the bot unless the bot has Connect allowed)
    await studyChannel.permissionOverwrites
      .edit(client.user.id, {
        ViewChannel: true,
        Connect: true,
        SendMessages: true,
        ManageChannels: true,
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
        'Missing Discord permissions to lock the channel! Make sure the bot has **Connect**, **Manage Channels**, and **Manage Roles** (or **Administrator**) permissions in Server Settings -> Roles.',
    };
  }

  const endTimeMs = Date.now() + durationMinutes * 60 * 1000;
  const endTimestampSec = Math.floor(endTimeMs / 1000);

  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`🔒 Focus Session Locked (${durationMinutes} mins)`)
    .setDescription(
      `Started by <@${starterUser.id}>\n\n` +
        `⏳ **Ends:** <t:${endTimestampSec}:R> (at <t:${endTimestampSec}:t>)\n` +
        `👥 **Locked-in Participants:** ${Array.from(participantIds)
          .map((id) => `<@${id}>`)
          .join(', ')}\n\n` +
        `*The room is now locked to outsiders. Stay focused!*`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('focus_unlock')
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
    endTime: endTimeMs,
    timeoutId,
    messageId: msg.id,
    durationMinutes,
  });

  return { ok: true };
}

// End a study session, unlock permissions, and move members to Break Lounge
async function endFocusSession(studyChannelId, endedEarly = false, endedByUser = null) {
  const session = activeSessions.get(studyChannelId);
  if (!session) return;

  clearTimeout(session.timeoutId);
  activeSessions.delete(studyChannelId);

  for (const userId of session.participants) {
    lockedUsers.delete(userId);
  }

  try {
    const guild = await client.guilds.fetch(session.guildId);
    const studyChannel = await guild.channels.fetch(session.studyChannelId).catch(() => null);
    const breakChannel = session.breakChannelId
      ? await guild.channels.fetch(session.breakChannelId).catch(() => null)
      : null;

    if (studyChannel) {
      // 1. Unlock @everyone Connect permission
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

      // 2. Notify participants
      const mentions = Array.from(session.participants)
        .map((id) => `<@${id}>`)
        .join(' ');

      const doneEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle(endedEarly ? '🔓 Focus Session Ended Early' : '🎉 Focus Session Complete!')
        .setDescription(
          endedEarly
            ? `Session unlocked early${endedByUser ? ` by <@${endedByUser.id}>` : ''}. The room is now open!`
            : `Great job ${mentions}! You completed **${session.durationMinutes} minutes** of focused study.\n` +
                (breakChannel
                  ? `Moving everyone to **${breakChannel.name}** for a well-deserved break!`
                  : `The room is now unlocked!`)
        );

      await studyChannel
        .send({ content: endedEarly ? undefined : mentions, embeds: [doneEmbed] })
        .catch(() => {});

      // 3. Move everyone currently in the Study Room to the Break Lounge (only when timer finishes naturally)
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

  // Register slash commands across all guilds the bot is in
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash commands (/setup-study, /focus, /unlock) registered!');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }

  // Ensure any study channels left locked from a previous restart are unlocked
  for (const [, guild] of client.guilds.cache) {
    const { studyChannel } = findStudyChannels(guild);
    if (studyChannel && !activeSessions.has(studyChannel.id)) {
      await studyChannel.permissionOverwrites
        .edit(guild.roles.everyone, { Connect: null })
        .catch(() => {});
    }
  }
});

// Handle Voice State Updates (Joining, Leaving, or trying to hop channels)
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  const guild = newState.guild || oldState.guild;
  const { studyChannel } = findStudyChannels(guild);

  // Case 1: User is locked into an active session and tries to switch to a different voice channel
  const lockedStudyChannelId = lockedUsers.get(member.id);
  if (
    lockedStudyChannelId &&
    newState.channelId &&
    newState.channelId !== lockedStudyChannelId
  ) {
    const targetStudyChannel = guild.channels.cache.get(lockedStudyChannelId);
    if (targetStudyChannel && activeSessions.has(lockedStudyChannelId)) {
      // Pull them right back into the Study Room!
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

  // Case 2: User joins the Study Room when no session is active -> Send timer buttons in voice text chat
  if (
    studyChannel &&
    newState.channelId === studyChannel.id &&
    oldState.channelId !== studyChannel.id
  ) {
    if (!activeSessions.has(studyChannel.id)) {
      const humanCount = studyChannel.members.filter((m) => !m.user.bot).size;
      // Send prompt when the first person enters the unlocked Study Room
      if (humanCount === 1) {
        await studyChannel.send(buildPromptPayload(studyChannel)).catch((err) => {
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

        const category = await guild.channels.create({
          name: '📚 STUDY ZONE',
          type: ChannelType.GuildCategory,
        });

        const studyChannel = await guild.channels.create({
          name: STUDY_CHANNEL_NAME,
          type: ChannelType.GuildVoice,
          parent: category.id,
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

        const breakChannel = await guild.channels.create({
          name: BREAK_CHANNEL_NAME,
          type: ChannelType.GuildVoice,
          parent: category.id,
        });

        return interaction.editReply(
          `✅ Created study channels!\n` +
            `• **Study Room:** <#${studyChannel.id}> (Join this room to start a focus timer)\n` +
            `• **Break Lounge:** <#${breakChannel.id}> (Users are moved here when the timer finishes)`
        );
      }

      if (commandName === 'focus') {
        const minutes = interaction.options.getInteger('minutes');
        const { studyChannel, breakChannel } = findStudyChannels(guild);

        if (!studyChannel) {
          return interaction.reply({
            content: '❌ No Study Room found! Run `/setup-study` first to create the channels.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (member.voice.channelId !== studyChannel.id) {
          return interaction.reply({
            content: `❌ Join <#${studyChannel.id}> first before starting a focus session!`,
            flags: MessageFlags.Ephemeral,
          });
        }

        await interaction.deferReply();
        const res = await startFocusSession(
          guild,
          studyChannel,
          breakChannel,
          minutes,
          interaction.user
        );
        if (!res.ok) {
          return interaction.editReply(`❌ ${res.error}`);
        }
        return interaction.editReply(`🔒 Focus session started for **${minutes} minutes**!`);
      }

      if (commandName === 'unlock') {
        const { studyChannel } = findStudyChannels(guild);
        if (!studyChannel || !activeSessions.has(studyChannel.id)) {
          return interaction.reply({
            content: 'ℹ️ There is no active focus session right now.',
            flags: MessageFlags.Ephemeral,
          });
        }

        await endFocusSession(studyChannel.id, true, interaction.user);
        return interaction.reply('🔓 Focus session ended and room unlocked!');
      }
    }

    // 2. Button Clicks
    if (interaction.isButton()) {
      const { customId, guild, member } = interaction;
      const { studyChannel, breakChannel } = findStudyChannels(guild);

      if (!studyChannel) {
        return interaction.reply({
          content: '❌ Study Room channel not found. Run `/setup-study` first.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (customId.startsWith('focus_') && customId !== 'focus_unlock') {
        if (member.voice.channelId !== studyChannel.id) {
          return interaction.reply({
            content: `❌ You must be inside <#${studyChannel.id}> to start the timer!`,
            flags: MessageFlags.Ephemeral,
          });
        }

        const minutes = parseInt(customId.replace('focus_', ''), 10);
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

      if (customId === 'focus_unlock') {
        const session = activeSessions.get(studyChannel.id);
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
        await endFocusSession(studyChannel.id, true, interaction.user);
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

