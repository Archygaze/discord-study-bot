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

// Track pending timers when a user runs /study from text chat before connecting to voice
// Map<channelId, { userId: string, durationMs: number, originalMinutes: number, isResumed: boolean, invitedFriendIds?: string[] }>
const pendingRoomTimers = new Map();

// Track friends invited to a specific Study Room via /study together so they are always allowed in & pulled in
// Map<channelId, Set<userId>>
const roomInvitedFriends = new Map();

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
        .setDescription('Automatic Pomodoro study with friends & automated Break Lounge breaks!')
        .addStringOption((opt) =>
          opt
            .setName('friends')
            .setDescription('Tag friends to study with (optional, e.g. @friend1 @friend2)')
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('hours')
            .setDescription('Total study hours (optional — default: 2 hrs = 4 rounds)')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(24)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('break_minutes')
            .setDescription('Break time per round (optional — choices: 5, 10, 15, 20, 30. Default: 5)')
            .setRequired(false)
            .addChoices(
              { name: '5 minutes (Standard)', value: 5 },
              { name: '10 minutes', value: 10 },
              { name: '15 minutes (Long Break)', value: 15 },
              { name: '20 minutes', value: 20 },
              { name: '30 minutes', value: 30 }
            )
        )
        .addBooleanOption((opt) =>
          opt
            .setName('separate_rooms')
            .setDescription('Private solo rooms (focus alone, meet in Break Lounge)? Default: False')
            .setRequired(false)
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

// Helper: Format the voice status string for Pomodoro study round ("username is studying • R1/4 • Xm left")
function formatPomoStudyStatus(participantNames, currentRound, totalRounds, minutesLeft) {
  const names = participantNames.join(', ');
  const verb = participantNames.length === 1 ? 'is' : 'are';
  const text = `🔒 ${names} ${verb} studying • R${currentRound}/${totalRounds} • ${minutesLeft}m left`;
  return text.slice(0, 480);
}

// Helper: Format the voice status string for Pomodoro break ("☕ On Break (R1/4 done) • Xm left")
function formatPomoBreakStatus(currentRound, totalRounds, minutesLeft) {
  const text = `☕ On Break (R${currentRound}/${totalRounds} done) • ${minutesLeft}m left`;
  return text.slice(0, 480);
}

// Build the prompt message with duration buttons
function buildPromptPayload(studyChannel, isSolo, includeJoinButton = false) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(isSolo ? `📖 ${studyChannel.name} (Solo)` : `👥 ${studyChannel.name} (Group Pomodoro)`)
    .setDescription(
      `Welcome to <#${studyChannel.id}>!\n` +
        (isSolo
          ? `This is your **1-person** study room.\n\n` +
            `Select a timer below (or type \`/study alone\`) to **start & lock in**:\n` +
            `• 🔒 **Room Locks:** Nobody else can enter while the timer runs.\n` +
            `• 💬 **Live Status:** Sets channel status to \`[Username] is studying • Xm left\`.\n` +
            `• 🚫 **No Channel Hopping:** Switching channels pulls you right back here.\n` +
            `• 💾 **Auto-Save on Disconnect:** Remaining time resumes next time you join!\n` +
            `• ☕ **Auto-Break:** Moves you to **${BREAK_CHANNEL_NAME}** & deletes the room when done!`
          : `This is a **Pomodoro Group Study Room**! Focus together with scheduled study rounds and automatic breaks in the **Break Lounge**.\n\n` +
            `• 🍅 **Study Rounds:** Room locks to outsiders while you focus together.\n` +
            `• ☕ **Break Lounge:** When a round finishes, everyone is moved to **${BREAK_CHANNEL_NAME}** to chill!\n` +
            `• 🔄 **Auto-Return:** When the break ends, everyone is automatically pulled back in for the next round!\n` +
            `• 🚪 **No Outsiders:** Only tagged friends & participants can enter.\n\n` +
            `Select a Pomodoro schedule below (or run \`/study together\` with custom times):`)
    )
    .setFooter({
      text: isSolo
        ? 'Choose a focus duration below to lock in'
        : 'Choose a Pomodoro schedule or custom focus timer',
    });

  let row;
  if (isSolo) {
    row = new ActionRowBuilder().addComponents(
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
  } else {
    row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`pomo_25_5_4_${studyChannel.id}`)
        .setLabel('Classic (25m/5m × 4)')
        .setEmoji('🍅')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`pomo_50_10_2_${studyChannel.id}`)
        .setLabel('Deep Work (50m/10m × 2)')
        .setEmoji('🔥')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`pomo_20_5_2_${studyChannel.id}`)
        .setLabel('Quick (20m/5m × 2)')
        .setEmoji('⚡')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`focus_30_${studyChannel.id}`)
        .setLabel('Single 30m Focus')
        .setEmoji('⏱️')
        .setStyle(ButtonStyle.Secondary)
    );
  }

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

// Helper: Check if all invited friends have joined the room to start the timer automatically!
// Rule:
// - Wait until EVERYONE invited (100% of invited friends) is in the voice channel!
// - If someone can't make it or is late, the user can click the "▶️ Start Study Session Now" button at any time.
function checkRoomReadyToStart(studyChannel) {
  const invitedSet = roomInvitedFriends.get(studyChannel.id);
  const humanMembers = studyChannel.members.filter((m) => !m.user.bot);
  const presentCount = humanMembers.size;

  if (!invitedSet || invitedSet.size <= 1) {
    return { ready: presentCount >= 1, presentCount, totalExpected: 1, requiredCount: 1 };
  }

  const totalExpected = invitedSet.size;
  const requiredCount = totalExpected;
  const invitedPresentCount = humanMembers.filter((m) => invitedSet.has(m.id)).size;

  return {
    ready: invitedPresentCount >= requiredCount,
    presentCount: invitedPresentCount,
    totalExpected,
    requiredCount,
  };
}

// Start or resume a locked study session in a specific studyChannel
async function startFocusSession(
  guild,
  studyChannel,
  breakChannel,
  durationMs,
  starterUser,
  isResumed = false,
  originalMinutes = null,
  extraInvitedIds = [],
  pomodoroOptions = null
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
      error: `Join **${studyChannel.name}** (<#${studyChannel.id}>) first to start the focus timer!`,
    };
  }

  const participantIds = new Set(membersInRoom.map((m) => m.id));
  const participantNames = membersInRoom.map((m) => m.displayName || m.user.username);

  // Also include any friends who were invited via /study together (even if they haven't connected their voice yet!)
  const invitedSet = roomInvitedFriends.get(studyChannel.id) || new Set();
  for (const id of extraInvitedIds) {
    invitedSet.add(id);
  }
  for (const friendId of invitedSet) {
    if (!participantIds.has(friendId)) {
      const friendMember = await guild.members.fetch(friendId).catch(() => null);
      if (friendMember && !friendMember.user.bot) {
        participantIds.add(friendId);
        // If they connected to another voice channel in the meantime, pull them right in!
        if (friendMember.voice.channelId && friendMember.voice.channelId !== studyChannel.id) {
          await friendMember.voice
            .setChannel(studyChannel, 'Pulled into locked group study session')
            .catch(() => {});
          participantNames.push(friendMember.displayName || friendMember.user.username);
        }
      }
    }
  }

  const isPomodoro = !!pomodoroOptions;
  const isSeparateRooms = !!(pomodoroOptions && pomodoroOptions.isSeparateRooms);
  const currentRound = pomodoroOptions ? pomodoroOptions.currentRound || 1 : 1;
  const totalRounds = pomodoroOptions ? pomodoroOptions.totalRounds || 4 : 1;
  const studyMinutes = pomodoroOptions
    ? pomodoroOptions.studyMinutes || 25
    : Math.max(1, Math.ceil(durationMs / 60000));
  const breakMinutes = pomodoroOptions ? pomodoroOptions.breakMinutes || 5 : 5;

  const actualDurationMs = isPomodoro ? studyMinutes * 60 * 1000 : durationMs;
  const displayMinutes = isPomodoro ? studyMinutes : Math.max(1, Math.ceil(actualDurationMs / 60000));
  const totalMinutes = originalMinutes || displayMinutes;

  const endTimeMs = Date.now() + actualDurationMs;
  const endTimestampSec = Math.floor(endTimeMs / 1000);

  const allRoomIds = isSeparateRooms && pomodoroOptions.allRoomIds
    ? pomodoroOptions.allRoomIds
    : new Set([studyChannel.id]);

  if (isSeparateRooms && pomodoroOptions.userRooms) {
    // Parallel Solo Study: lock each member into their own private 1-person cubicle
    for (const [uid, rId] of pomodoroOptions.userRooms.entries()) {
      lockedUsers.set(uid, rId);
      pausedSessions.delete(uid);

      const mem = await guild.members.fetch(uid).catch(() => null);
      const name = mem ? (mem.displayName || mem.user.username) : 'Student';
      await setVoiceChannelStatus(
        rId,
        formatPomoStudyStatus([name], currentRound, totalRounds, displayMinutes)
      );

      const cubicleCh = await guild.channels.fetch(rId).catch(() => null);
      if (cubicleCh) {
        const cubicleEmbed = new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle(`🍅 Private Focus Cubicle — Round ${currentRound}/${totalRounds} (${displayMinutes}m)`)
          .setDescription(
            `Welcome <@${uid}>! This is your **private focus cubicle**.\n\n` +
              `💬 **Status:** \`${formatPomoStudyStatus([name], currentRound, totalRounds, displayMinutes)}\`\n` +
              `⏳ **Study Ends:** <t:${endTimestampSec}:R> (at <t:${endTimestampSec}:t>)\n` +
              `☕ **Next Up:** ${breakMinutes}-minute group break in <#${breakChannel ? breakChannel.id : ''}>\n` +
              `👥 **Study Group:** ${Array.from(participantIds).map((id) => `<@${id}>`).join(', ')}\n\n` +
              `*Focus with zero voice distractions! When the timer ends, everyone will automatically meet in the Break Lounge!*`
          );

        const cubicleRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`pomo_skiptobreak_${studyChannel.id}`)
            .setLabel('Skip to Break Early')
            .setEmoji('☕')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`focus_unlock_${studyChannel.id}`)
            .setLabel('End Session & Unlock')
            .setEmoji('🔓')
            .setStyle(ButtonStyle.Danger)
        );

        await cubicleCh.send({ content: `<@${uid}>`, embeds: [cubicleEmbed], components: [cubicleRow] }).catch(() => {});
      }
    }
  } else {
    // Standard shared study room
    for (const m of membersInRoom) {
      lockedUsers.set(m.id, studyChannel.id);
      pausedSessions.delete(m.id);
    }

    // Lock Method A: Set userLimit to total participant count (including invited friends so they never see "Channel Full"!)
    await studyChannel.setUserLimit(Math.max(1, participantIds.size)).catch(() => {});

    // Lock Method B: Grant Connect + ViewChannel to every participant & invited friend BEFORE denying @everyone
    try {
      await studyChannel.permissionOverwrites.edit(client.user.id, {
        ViewChannel: true,
        Connect: true,
        SendMessages: true,
        ManageChannels: true,
        MoveMembers: true,
      });
      for (const userId of participantIds) {
        await studyChannel.permissionOverwrites.edit(userId, {
          ViewChannel: true,
          Connect: true,
        });
      }
      await studyChannel.permissionOverwrites.edit(guild.roles.everyone, { Connect: false });
    } catch {
      // Even without Manage Roles, Method A (userLimit) + Method C (auto-bouncing outsiders) locks the room!
    }

    // Set the Voice Channel Status immediately
    const initialStatus = isPomodoro
      ? formatPomoStudyStatus(participantNames, currentRound, totalRounds, displayMinutes)
      : formatStudyStatus(participantNames, displayMinutes);
    await setVoiceChannelStatus(studyChannel.id, initialStatus);

    const embed = new EmbedBuilder()
      .setColor(isResumed ? 0xfee75c : 0xed4245)
      .setTitle(
        isPomodoro
          ? `🍅 Pomodoro Study — Round ${currentRound}/${totalRounds} (${displayMinutes}m)`
          : isResumed
            ? `🔄 Resumed Focus Session (${displayMinutes} mins left)`
            : `🔒 Focus Session Locked (${displayMinutes} mins)`
      )
      .setDescription(
        isPomodoro
          ? `Started by <@${starterUser.id}> in <#${studyChannel.id}>\n\n` +
              `💬 **Channel Status:** \`${formatPomoStudyStatus(participantNames, currentRound, totalRounds, displayMinutes)}\`\n` +
              `⏳ **Study Ends:** <t:${endTimestampSec}:R> (at <t:${endTimestampSec}:t>)\n` +
              `☕ **Next Up:** ${breakMinutes}-minute break in <#${breakChannel ? breakChannel.id : ''}>\n` +
              `🔁 **Schedule:** ${totalRounds} rounds of ${studyMinutes}m study + ${breakMinutes}m break\n` +
              `👥 **Locked-in:** ${Array.from(participantIds)
                .map((id) => `<@${id}>`)
                .join(', ')}\n\n` +
              `*During study rounds, this room is locked to outsiders. When the timer hits zero, everyone moves to Break Lounge automatically!*`
          : (isResumed
              ? `Welcome back <@${starterUser.id}>! Continuing your previous **${totalMinutes}-minute** session in <#${studyChannel.id}>.\n\n`
              : `Started by <@${starterUser.id}> in <#${studyChannel.id}>\n\n`) +
              `💬 **Channel Status:** \`${formatStudyStatus(participantNames, displayMinutes)}\`\n` +
              `⏳ **Ends:** <t:${endTimestampSec}:R> (at <t:${endTimestampSec}:t>)\n` +
              `👥 **Locked-in:** ${Array.from(participantIds)
                .map((id) => `<@${id}>`)
                .join(', ')}\n\n` +
              `*This room is locked to outsiders. If you log off early, your remaining time will be saved!*`
      );

    const row = new ActionRowBuilder();
    if (isPomodoro) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`pomo_skiptobreak_${studyChannel.id}`)
          .setLabel('Skip to Break Early')
          .setEmoji('☕')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`focus_unlock_${studyChannel.id}`)
          .setLabel('End Session & Unlock Early')
          .setEmoji('🔓')
          .setStyle(ButtonStyle.Danger)
      );
    } else {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`focus_unlock_${studyChannel.id}`)
          .setLabel('End Session & Unlock Early')
          .setEmoji('🔓')
          .setStyle(ButtonStyle.Danger)
      );
    }

    await studyChannel.send({ embeds: [embed], components: [row] }).catch(() => {});
  }

  // Update the Voice Channel Status every minute as the timer counts down
  const intervalId = setInterval(async () => {
    const remainingMs = endTimeMs - Date.now();
    if (remainingMs <= 0) return;
    const minsLeft = Math.max(1, Math.ceil(remainingMs / 60000));

    if (isSeparateRooms && pomodoroOptions.userRooms) {
      for (const [uid, rId] of pomodoroOptions.userRooms.entries()) {
        const mem = guild.members.cache.get(uid);
        const name = mem ? (mem.displayName || mem.user.username) : 'Student';
        await setVoiceChannelStatus(
          rId,
          formatPomoStudyStatus([name], currentRound, totalRounds, minsLeft)
        );
      }
    } else {
      const status = isPomodoro
        ? formatPomoStudyStatus(participantNames, currentRound, totalRounds, minsLeft)
        : formatStudyStatus(participantNames, minsLeft);
      await setVoiceChannelStatus(studyChannel.id, status);
    }
  }, 60 * 1000);

  const timeoutId = setTimeout(() => {
    if (isPomodoro) {
      transitionToPomodoroBreak(studyChannel.id);
    } else {
      endFocusSession(studyChannel.id, false);
    }
  }, actualDurationMs);

  const sessionObj = {
    guildId: guild.id,
    studyChannelId: studyChannel.id,
    breakChannelId: breakChannel ? breakChannel.id : null,
    participants: participantIds,
    participantNames,
    endTime: endTimeMs,
    timeoutId,
    intervalId,
    durationMinutes: totalMinutes,
    isPomodoro,
    phase: 'study',
    currentRound,
    totalRounds,
    studyMinutes,
    breakMinutes,
    isSeparateRooms,
    userRooms: pomodoroOptions && pomodoroOptions.userRooms ? pomodoroOptions.userRooms : null,
    allRoomIds,
  };

  for (const rId of allRoomIds) {
    activeSessions.set(rId, sessionObj);
  }

  return { ok: true };
}

// Transition a Pomodoro session from Study phase to Break phase in the Break Lounge
async function transitionToPomodoroBreak(studyChannelId) {
  const session = activeSessions.get(studyChannelId);
  if (!session) return;

  clearTimeout(session.timeoutId);
  clearInterval(session.intervalId);

  session.phase = 'break';

  // Temporarily unlock participants so they can chat freely in the Break Lounge without being forced back to study room
  for (const userId of session.participants) {
    lockedUsers.delete(userId);
  }

  try {
    const guild = await client.guilds.fetch(session.guildId);
    const foundBreak = findBreakChannel(guild);
    const breakChannel = session.breakChannelId
      ? await guild.channels.fetch(session.breakChannelId).catch(() => foundBreak)
      : foundBreak;

    const mentions = Array.from(session.participants)
      .map((id) => `<@${id}>`)
      .join(' ');

    const breakDurationMs = session.breakMinutes * 60 * 1000;
    const breakEndMs = Date.now() + breakDurationMs;
    const breakEndSec = Math.floor(breakEndMs / 1000);
    session.endTime = breakEndMs;

    const roomIdsToProcess = session.allRoomIds ? Array.from(session.allRoomIds) : [session.studyChannelId];

    for (const rId of roomIdsToProcess) {
      spawningRooms.add(rId);
      setTimeout(() => spawningRooms.delete(rId), 5000);
      const ch = await guild.channels.fetch(rId).catch(() => null);
      if (ch) {
        if (breakChannel) {
          for (const [, member] of ch.members) {
            if (!member.user.bot) {
              await member.voice
                .setChannel(breakChannel, 'Pomodoro break time - moved to Break Lounge')
                .catch((err) => {
                  console.error(`Failed to move ${member.user.tag} to Break Lounge:`, err.message);
                });
            }
          }
        }
        await setVoiceChannelStatus(
          rId,
          formatPomoBreakStatus(session.currentRound, session.totalRounds, session.breakMinutes)
        );
      }
    }

    const breakEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle(
        session.isSeparateRooms
          ? `☕ Break Time! — Cubicles Meet in Break Lounge (${session.currentRound}/${session.totalRounds})`
          : `☕ Break Time! — Round ${session.currentRound}/${session.totalRounds} Complete`
      )
      .setDescription(
        `Awesome job ${mentions}! You completed **Round ${session.currentRound} of ${session.totalRounds}** (${session.studyMinutes}m)${session.isSeparateRooms ? ' in your private cubicles' : ''}.\n\n` +
          `Take **${session.breakMinutes} minutes** to relax, stretch, grab water, or chat in the Break Lounge!\n\n` +
          `⏳ **Break Ends:** <t:${breakEndSec}:R> (at <t:${breakEndSec}:t>)\n` +
          `🔜 **Next Up:** Round ${session.currentRound + 1 <= session.totalRounds ? `${session.currentRound + 1}/${session.totalRounds} (${session.studyMinutes}m study)` : 'Final Wrap-Up'}\n\n` +
          `*You will automatically be moved back to your ${session.isSeparateRooms ? 'private cubicles' : 'Study Room'} when the break timer finishes!*`
      );

    const breakRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`pomo_skipbreak_${session.studyChannelId}`)
        .setLabel('Skip Break & Resume Study')
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`pomo_extendbreak_${session.studyChannelId}`)
        .setLabel('+5m Break')
        .setEmoji('⏳')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`focus_unlock_${session.studyChannelId}`)
        .setLabel('End Session Early')
        .setEmoji('🔓')
        .setStyle(ButtonStyle.Danger)
    );

    if (breakChannel) {
      await breakChannel
        .send({ content: mentions, embeds: [breakEmbed], components: [breakRow] })
        .catch(() => {});
    }

    // Interval to update voice status countdown every minute
    session.intervalId = setInterval(async () => {
      const remainingMs = breakEndMs - Date.now();
      if (remainingMs <= 0) return;
      const minsLeft = Math.max(1, Math.ceil(remainingMs / 60000));
      for (const rId of roomIdsToProcess) {
        await setVoiceChannelStatus(
          rId,
          formatPomoBreakStatus(session.currentRound, session.totalRounds, minsLeft)
        );
      }
    }, 60 * 1000);

    // Break timer finishes -> resume next study round
    session.timeoutId = setTimeout(() => {
      resumePomodoroStudy(session.studyChannelId);
    }, breakDurationMs);
  } catch (err) {
    console.error('Error during transitionToPomodoroBreak:', err);
  }
}

// Resume a Pomodoro session for the next study round after break finishes
async function resumePomodoroStudy(studyChannelId) {
  const session = activeSessions.get(studyChannelId);
  if (!session) return;

  clearTimeout(session.timeoutId);
  clearInterval(session.intervalId);

  session.currentRound++;

  // If all rounds are completed, end the session cleanly!
  if (session.currentRound > session.totalRounds) {
    return endPomodoroSessionComplete(studyChannelId);
  }

  session.phase = 'study';

  try {
    const guild = await client.guilds.fetch(session.guildId);
    const foundBreak = findBreakChannel(guild);
    const breakChannel = session.breakChannelId
      ? await guild.channels.fetch(session.breakChannelId).catch(() => foundBreak)
      : foundBreak;

    const studyDurationMs = session.studyMinutes * 60 * 1000;
    const endTimeMs = Date.now() + studyDurationMs;
    const endTimestampSec = Math.floor(endTimeMs / 1000);
    session.endTime = endTimeMs;

    if (session.isSeparateRooms && session.userRooms) {
      // Parallel Solo Study: Return each user to their individual cubicle
      const userRoomsEntries =
        session.userRooms instanceof Map
          ? Array.from(session.userRooms.entries())
          : Object.entries(session.userRooms);

      for (const [userId, roomId] of userRoomsEntries) {
        lockedUsers.set(userId, roomId);
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member && member.voice && member.voice.channelId) {
          await member.voice
            .setChannel(roomId, `Pomodoro Round ${session.currentRound} starting - back to your cubicle!`)
            .catch(() => {});
        }

        const cubicle = await guild.channels.fetch(roomId).catch(() => null);
        if (cubicle) {
          await cubicle.setUserLimit(1).catch(() => {});
          const userName = member ? (member.displayName || member.user.username) : 'Student';
          await setVoiceChannelStatus(
            roomId,
            formatPomoStudyStatus([userName], session.currentRound, session.totalRounds, session.studyMinutes)
          );

          const roundEmbed = new EmbedBuilder()
            .setColor(0xed4245)
            .setTitle(`🍅 Pomodoro Round ${session.currentRound}/${session.totalRounds} — Private Cubicle (${session.studyMinutes}m)`)
            .setDescription(
              `🔔 **Break is over! Welcome back to your private cubicle, <@${userId}>!**\n\n` +
                `💬 **Status:** \`${formatPomoStudyStatus([userName], session.currentRound, session.totalRounds, session.studyMinutes)}\`\n` +
                `⏳ **Study Ends:** <t:${endTimestampSec}:R> (at <t:${endTimestampSec}:t>)\n` +
                `☕ **Next Break:** ${session.breakMinutes} mins in ${breakChannel ? `<#${breakChannel.id}>` : 'Break Lounge'}\n\n` +
                `*This cubicle is locked (1 person max). Stay focused!*`
            );

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`pomo_skiptobreak_${roomId}`)
              .setLabel('Skip to Break Early')
              .setEmoji('☕')
              .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(`focus_unlock_${roomId}`)
              .setLabel('End Session & Unlock')
              .setEmoji('🔓')
              .setStyle(ButtonStyle.Danger)
          );

          await cubicle.send({ content: `<@${userId}>`, embeds: [roundEmbed], components: [row] }).catch(() => {});
        }
      }

      // Interval to update voice status countdown for each cubicle
      session.intervalId = setInterval(async () => {
        const remainingMs = endTimeMs - Date.now();
        if (remainingMs <= 0) return;
        const minsLeft = Math.max(1, Math.ceil(remainingMs / 60000));
        for (const [userId, roomId] of userRoomsEntries) {
          const member = await guild.members.fetch(userId).catch(() => null);
          const userName = member ? (member.displayName || member.user.username) : 'Student';
          await setVoiceChannelStatus(
            roomId,
            formatPomoStudyStatus([userName], session.currentRound, session.totalRounds, minsLeft)
          );
        }
      }, 60 * 1000);
    } else {
      const studyChannel = await guild.channels.fetch(session.studyChannelId).catch(() => null);
      if (!studyChannel) return;

      // Move all participants back into the Study Room from Break Lounge (or anywhere in voice in the guild)
      for (const userId of session.participants) {
        lockedUsers.set(userId, studyChannel.id);
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member && member.voice && member.voice.channelId) {
          await member.voice
            .setChannel(studyChannel, `Pomodoro Round ${session.currentRound} starting - back to study!`)
            .catch(() => {});
        }
      }

      // Re-lock channel limit to participants
      await studyChannel.setUserLimit(Math.max(1, session.participants.size)).catch(() => {});

      await setVoiceChannelStatus(
        studyChannel.id,
        formatPomoStudyStatus(session.participantNames, session.currentRound, session.totalRounds, session.studyMinutes)
      );

      session.intervalId = setInterval(async () => {
        const remainingMs = endTimeMs - Date.now();
        if (remainingMs <= 0) return;
        const minsLeft = Math.max(1, Math.ceil(remainingMs / 60000));
        await setVoiceChannelStatus(
          studyChannel.id,
          formatPomoStudyStatus(session.participantNames, session.currentRound, session.totalRounds, minsLeft)
        );
      }, 60 * 1000);

      const mentions = Array.from(session.participants)
        .map((id) => `<@${id}>`)
        .join(' ');

      const roundEmbed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle(`🍅 Pomodoro Study — Round ${session.currentRound}/${session.totalRounds} (${session.studyMinutes} mins)`)
        .setDescription(
          `🔔 **Break is over! Time to get back into focus mode!**\n\n` +
            `💬 **Channel Status:** \`${formatPomoStudyStatus(session.participantNames, session.currentRound, session.totalRounds, session.studyMinutes)}\`\n` +
            `⏳ **Study Ends:** <t:${endTimestampSec}:R> (at <t:${endTimestampSec}:t>)\n` +
            `☕ **Next Break:** ${session.breakMinutes} mins in ${breakChannel ? `<#${breakChannel.id}>` : 'Break Lounge'}\n` +
            `👥 **Locked-in:** ${mentions}\n\n` +
            `*This room is locked to outsiders. Stay focused!*`
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`pomo_skiptobreak_${studyChannel.id}`)
          .setLabel('Skip to Break Early')
          .setEmoji('☕')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`focus_unlock_${studyChannel.id}`)
          .setLabel('End Session & Unlock')
          .setEmoji('🔓')
          .setStyle(ButtonStyle.Danger)
      );

      await studyChannel.send({ content: mentions, embeds: [roundEmbed], components: [row] }).catch(() => {});
    }

    session.timeoutId = setTimeout(() => {
      transitionToPomodoroBreak(studyChannelId);
    }, studyDurationMs);
  } catch (err) {
    console.error('Error during resumePomodoroStudy:', err);
  }
}

// Complete all Pomodoro rounds, move to Break Lounge, and clean up room
async function endPomodoroSessionComplete(studyChannelId) {
  const session = activeSessions.get(studyChannelId);
  if (!session) return;

  clearTimeout(session.timeoutId);
  clearInterval(session.intervalId);

  const roomIds = session.allRoomIds ? Array.from(session.allRoomIds) : [session.studyChannelId];
  for (const rId of roomIds) {
    activeSessions.delete(rId);
    roomInvitedFriends.delete(rId);
  }

  for (const userId of session.participants) {
    lockedUsers.delete(userId);
    pausedSessions.delete(userId);
  }

  try {
    const guild = await client.guilds.fetch(session.guildId);
    const foundBreak = findBreakChannel(guild);
    const breakChannel = session.breakChannelId
      ? await guild.channels.fetch(session.breakChannelId).catch(() => foundBreak)
      : foundBreak;

    const mentions = Array.from(session.participants)
      .map((id) => `<@${id}>`)
      .join(' ');
    const totalMinutesStudied = session.totalRounds * session.studyMinutes;

    const finalEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('🏆 Pomodoro Marathon Complete!')
      .setDescription(
        `🎉 Amazing work ${mentions}!\n\n` +
          `You completed all **${session.totalRounds} rounds** (${totalMinutesStudied} total minutes of focused study)${session.isSeparateRooms ? ' in your private cubicles' : ''}!\n\n` +
          `Moved everyone to **${breakChannel ? breakChannel.name : 'Break Lounge'}** for a well-deserved rest!`
      );

    for (const rId of roomIds) {
      spawningRooms.add(rId);
      const room = await guild.channels.fetch(rId).catch(() => null);
      if (room) {
        if (breakChannel) {
          for (const [, member] of room.members) {
            if (!member.user.bot) {
              await member.voice
                .setChannel(breakChannel, 'Pomodoro complete - moved to Break Lounge')
                .catch((err) => {
                  console.error(`Failed to move ${member.user.tag} to Break Lounge:`, err.message);
                });
            }
          }
        }
        if (isDynamicRoom(room)) {
          setTimeout(async () => {
            spawningRooms.delete(room.id);
            const refreshed = await guild.channels.fetch(room.id).catch(() => null);
            if (refreshed && refreshed.members.filter((m) => !m.user.bot).size === 0) {
              dynamicStudyRooms.delete(room.id);
              await refreshed.delete('Pomodoro finished and room is empty').catch(() => {});
            }
          }, 4000);
        } else {
          spawningRooms.delete(room.id);
          await setVoiceChannelStatus(room.id, '');
        }
      }
    }

    if (breakChannel) {
      await breakChannel.send({ content: mentions, embeds: [finalEmbed] }).catch(() => {});
    }
  } catch (err) {
    console.error('Error in endPomodoroSessionComplete:', err);
  }
}

// End a study session, move members to the single Break Lounge, and delete dynamic room
async function endFocusSession(studyChannelId, endedEarly = false, endedByUser = null) {
  const session = activeSessions.get(studyChannelId);
  if (!session) return;

  clearTimeout(session.timeoutId);
  clearInterval(session.intervalId);

  const roomIds = session.allRoomIds ? Array.from(session.allRoomIds) : [session.studyChannelId];
  for (const rId of roomIds) {
    activeSessions.delete(rId);
    roomInvitedFriends.delete(rId);
  }

  for (const userId of session.participants) {
    lockedUsers.delete(userId);
    pausedSessions.delete(userId);
  }

  try {
    const guild = await client.guilds.fetch(session.guildId);
    const foundBreak = findBreakChannel(guild);
    const breakChannel = session.breakChannelId
      ? await guild.channels.fetch(session.breakChannelId).catch(() => foundBreak)
      : foundBreak;

    const mentions = Array.from(session.participants)
      .map((id) => `<@${id}>`)
      .join(' ');

    const resultEmbed = new EmbedBuilder()
      .setColor(endedEarly ? 0xfee75c : 0x57f287)
      .setTitle(endedEarly ? '🔓 Focus Session Ended' : '🎉 Focus Session Complete!')
      .setDescription(
        endedEarly
          ? `Session ended early${endedByUser ? ` by <@${endedByUser.id}>` : ''}${session.isPomodoro ? ` (after Round ${session.currentRound}/${session.totalRounds})` : ''}. Moved everyone to **${breakChannel ? breakChannel.name : 'Break Lounge'}**!`
          : `Great job ${mentions}! You completed **${session.durationMinutes} minutes** of focused study${session.isSeparateRooms ? ' in your private cubicles' : ''}. Enjoy your break!`
      );

    if (breakChannel) {
      // 1. Move everyone currently in any of the Study Rooms to the Break Lounge FIRST
      for (const rId of roomIds) {
        const room = await guild.channels.fetch(rId).catch(() => null);
        if (room) {
          for (const [, member] of room.members) {
            if (!member.user.bot) {
              await member.voice
                .setChannel(breakChannel, 'Focus session ended - moving to Break Lounge')
                .catch((err) => {
                  console.error(`Failed to move ${member.user.tag} to Break Lounge:`, err.message);
                });
            }
          }
        }
      }

      // 2. Send completion message in Break Lounge
      await breakChannel
        .send({ content: endedEarly ? undefined : mentions, embeds: [resultEmbed] })
        .catch(() => {});
    }

    // 3. Delete or reset all dynamic rooms
    for (const rId of roomIds) {
      spawningRooms.add(rId);
      const room = await guild.channels.fetch(rId).catch(() => null);
      if (room) {
        if (isDynamicRoom(room)) {
          setTimeout(async () => {
            spawningRooms.delete(room.id);
            const refreshed = await guild.channels.fetch(room.id).catch(() => null);
            if (refreshed && refreshed.members.filter((m) => !m.user.bot).size === 0) {
              dynamicStudyRooms.delete(room.id);
              await refreshed.delete('Study session ended and room is empty').catch(() => {});
            }
          }, 4000);
        } else {
          spawningRooms.delete(room.id);
          await setVoiceChannelStatus(room.id, '');
          await room.permissionOverwrites
            .edit(guild.roles.everyone, { Connect: null })
            .catch(() => {});
        }
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
            if (session && session.phase === 'break') {
              // Pomodoro session is resting in Break Lounge, keep study room reserved!
              continue;
            }
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
          'get in the study room. nobody leaves until the timer hits zero.\n\n' +
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
      const session = activeSessions.get(lockedStudyChannelId);
      if (session && session.phase === 'break') {
        // Allowed in Break Lounge or chatting during Pomodoro break
      } else {
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
  }

  // 1.5. If user was invited to an active/pending Group Study Room and just connected to ANY voice channel, pull them into their Study Room!
  if (newState.channelId && !oldState.channelId) {
    for (const [roomId, invitedSet] of roomInvitedFriends.entries()) {
      if (invitedSet.has(member.id) && newState.channelId !== roomId) {
        const session = activeSessions.get(roomId);
        if (session && session.phase === 'break') {
          const breakChannel = session.breakChannelId
            ? guild.channels.cache.get(session.breakChannelId)
            : findBreakChannel(guild);
          if (breakChannel && newState.channelId !== breakChannel.id) {
            await member.voice.setChannel(breakChannel, 'Joined voice during group study break').catch(() => {});
            return;
          }
        } else {
          const invitedRoom = guild.channels.cache.get(roomId);
          if (invitedRoom) {
            await member.voice
              .setChannel(invitedRoom, 'Joined voice after being invited via /study together')
              .catch(() => {});
            return;
          }
        }
      }
    }
  }
  const leftChannel = oldState.channel;
  if (leftChannel && isDynamicRoom(leftChannel) && leftChannel.id !== newState.channelId) {
    const remainingHumans = leftChannel.members.filter((m) => !m.user.bot).size;
    if (remainingHumans === 0) {
      if (activeSessions.has(leftChannel.id)) {
        const session = activeSessions.get(leftChannel.id);
        if (session && session.phase === 'break') {
          return; // Do NOT delete room or cancel session while resting in Break Lounge!
        }

        if (session && session.isSeparateRooms) {
          // Check if any other cubicles still have active human members
          let anyOtherHumans = false;
          if (session.allRoomIds) {
            for (const rId of session.allRoomIds) {
              if (rId === leftChannel.id) continue;
              const rCh = guild.channels.cache.get(rId);
              if (rCh && rCh.members.filter((m) => !m.user.bot).size > 0) {
                anyOtherHumans = true;
                break;
              }
            }
          }
          if (anyOtherHumans) {
            // Other friends are still studying in their cubicles!
            lockedUsers.delete(member.id);
            return;
          }
        }

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

    if (session.isSeparateRooms && session.userRooms) {
      const assignedRoomId =
        session.userRooms instanceof Map
          ? session.userRooms.get(member.id)
          : session.userRooms[member.id];
      if (assignedRoomId && assignedRoomId !== joinedChannel.id) {
        const correctRoom = guild.channels.cache.get(assignedRoomId);
        if (correctRoom) {
          await member.voice
            .setChannel(correctRoom, 'Redirected to your assigned private cubicle')
            .catch(() => {});
          return;
        }
      }
    }

    lockedUsers.set(member.id, joinedChannel.id);
    const displayName = member.displayName || member.user.username;
    if (!session.participantNames.includes(displayName)) {
      session.participantNames.push(displayName);
      const minsLeft = Math.max(1, Math.ceil((session.endTime - Date.now()) / 60000));
      await setVoiceChannelStatus(
        joinedChannel.id,
        formatStudyStatus(session.participantNames, minsLeft)
      );
    }
  }

  // 4. User joins a Study Room that has a pending timer (waiting for user or invited friends to join!)
  if (joinedChannel && pendingRoomTimers.has(joinedChannel.id)) {
    const refreshedJoinChannel = await guild.channels
      .fetch(joinedChannel.id)
      .catch(() => joinedChannel);
    const readiness = checkRoomReadyToStart(refreshedJoinChannel);
    const pending = pendingRoomTimers.get(joinedChannel.id);

    if (readiness.ready) {
      pendingRoomTimers.delete(joinedChannel.id);
      const breakChannel = findBreakChannel(guild);
      const starterUser =
        (await client.users.fetch(pending.userId).catch(() => null)) || member.user;
      await startFocusSession(
        guild,
        refreshedJoinChannel,
        breakChannel,
        pending.durationMs,
        starterUser,
        pending.isResumed,
        pending.originalMinutes,
        pending.invitedFriendIds || [],
        pending.pomodoroOptions || null
      );
    } else {
      await setVoiceChannelStatus(
        joinedChannel.id,
        `⏳ Waiting for friends (${readiness.presentCount}/${readiness.totalExpected} joined)...`
      );
      const startNowRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`focus_startnow_${joinedChannel.id}`)
          .setLabel('Start Study Session Now')
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Success)
      );
      await joinedChannel
        .send({
          content: `👋 <@${member.id}> joined! Waiting for **${readiness.requiredCount - readiness.presentCount}** more invited friend(s) before the **${pending.originalMinutes}-minute** timer starts (or click below to start now):`,
          components: [startNowRow],
        })
        .catch(() => {});
    }
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
        const hoursOpt = interaction.options.getInteger('hours');
        const minutesOpt = interaction.options.getInteger('minutes');
        const breakChannel = findBreakChannel(guild);

        let pomodoroOptions = null;
        let minutes = null;

        if (isSolo) {
          minutes = minutesOpt || 25;
        } else {
          // /study together ALWAYS runs an automated Pomodoro cycle!
          const breakMinutesOpt = interaction.options.getInteger('break_minutes');
          const studyMinutes = 25;
          const breakMinutes = breakMinutesOpt || 5;
          const roundLength = studyMinutes + breakMinutes;
          const totalRounds = hoursOpt ? Math.max(1, Math.round((hoursOpt * 60) / roundLength)) : 4;

          pomodoroOptions = {
            isPomodoro: true,
            studyMinutes,
            breakMinutes,
            totalRounds,
            currentRound: 1,
          };
          minutes = studyMinutes;
        }

        // Collect any number of @mentioned friends from the 'friends' string option!
        const friendsRaw = interaction.options.getString('friends') || '';
        const mentionedIds = Array.from(friendsRaw.matchAll(/<@!?(\d+)>/g), (m) => m[1]);
        const uniqueFriendIds = [...new Set(mentionedIds)].filter((id) => id !== member.id);
        const separateRoomsOpt = interaction.options.getBoolean('separate_rooms') || false;

        await interaction.deferReply();

        // Option A: Parallel Solo Study (Study Cubicles) — Everyone gets a private 1-person room and meets in Break Lounge!
        if (!isSolo && separateRoomsOpt) {
          const allParticipantIds = [member.id, ...uniqueFriendIds];
          const userRooms = new Map();
          const allRoomIds = [];
          const category = (findStudyCategory(guild) && findStudyCategory(guild).id) || null;

          const movedMembers = [];
          const offlineMembers = [];

          for (const pId of allParticipantIds) {
            const pMember = await guild.members.fetch(pId).catch(() => null);
            const pName = pMember ? (pMember.displayName || pMember.user.username) : 'Student';

            const cubicle = await guild.channels.create({
              name: `📖 ${pName}'s Cubicle`,
              type: ChannelType.GuildVoice,
              parent: category,
              userLimit: 1,
            });

            dynamicStudyRooms.add(cubicle.id);
            spawningRooms.add(cubicle.id);
            setTimeout(() => spawningRooms.delete(cubicle.id), 20000);

            // Restrict permissions so only this user and bot can connect
            await cubicle.permissionOverwrites
              .set([
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
                {
                  id: pId,
                  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
                },
                {
                  id: guild.roles.everyone.id,
                  deny: [PermissionFlagsBits.Connect],
                },
              ])
              .catch(() => {});

            userRooms.set(pId, cubicle.id);
            allRoomIds.push(cubicle.id);
            roomInvitedFriends.set(cubicle.id, new Set([pId]));

            // Move to cubicle if in voice
            if (pMember && pMember.voice && pMember.voice.channelId) {
              await pMember.voice
                .setChannel(cubicle, 'Moved to private cubicle for /study together')
                .catch(() => {});
              movedMembers.push(`<@${pId}>`);
            } else {
              offlineMembers.push(`<@${pId}>`);
            }
          }

          pomodoroOptions.isSeparateRooms = true;
          pomodoroOptions.userRooms = userRooms;
          pomodoroOptions.allRoomIds = allRoomIds;

          const callerCubicleId = userRooms.get(member.id);
          const callerCubicle = await guild.channels.fetch(callerCubicleId);

          // Build room links summary
          const roomLinks = allParticipantIds
            .map((pId) => {
              const rId = userRooms.get(pId);
              return `• <@${pId}>: <#${rId}>`;
            })
            .join('\n');

          // If caller is in voice, start session immediately!
          if (member.voice.channelId) {
            const res = await startFocusSession(
              guild,
              callerCubicle,
              breakChannel,
              minutes * 60 * 1000,
              interaction.user,
              false,
              minutes,
              uniqueFriendIds,
              pomodoroOptions
            );

            if (!res.ok) {
              return interaction.editReply(`❌ ${res.error}`);
            }

            return interaction.editReply({
              content:
                `🚪 **Parallel Solo Study started!**\n\n` +
                `🍅 **Pomodoro:** Round 1/${pomodoroOptions.totalRounds} (${pomodoroOptions.studyMinutes}m study / ${pomodoroOptions.breakMinutes}m break)\n` +
                `🔒 **Private Cubicles created:**\n${roomLinks}\n\n` +
                `☕ When the timer ends, everyone will automatically be moved to **${breakChannel ? breakChannel.name : 'Break Lounge'}** to chill together!`,
            });
          } else {
            // Caller not in voice yet -> set pending timer on callerCubicle
            pendingRoomTimers.set(callerCubicle.id, {
              userId: member.id,
              durationMs: minutes * 60 * 1000,
              originalMinutes: minutes,
              isResumed: false,
              invitedFriendIds: uniqueFriendIds,
              pomodoroOptions,
            });

            const joinRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setLabel(`Join Your Cubicle (${pomodoroOptions.studyMinutes}m Pomodoro)`)
                .setEmoji('🔊')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://discord.com/channels/${guild.id}/${callerCubicle.id}`)
            );

            return interaction.editReply({
              content:
                `✨ **Created your private cubicles for Parallel Solo Study!**\n\n` +
                `🍅 **Pomodoro:** ${pomodoroOptions.studyMinutes}m study / ${pomodoroOptions.breakMinutes}m break × ${pomodoroOptions.totalRounds} rounds\n` +
                `🔒 **Assigned Cubicles:**\n${roomLinks}\n\n` +
                `Click **🔊 Join Your Cubicle** below to connect and start your focus timer:`,
              components: [joinRow],
            });
          }
        }

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
        }

        // Store invited friends on targetRoom BEFORE moving anyone in, so VoiceStateUpdate always knows who is invited!
        if (uniqueFriendIds.length > 0) {
          const invSet = roomInvitedFriends.get(targetRoom.id) || new Set();
          invSet.add(member.id);
          for (const fid of uniqueFriendIds) {
            invSet.add(fid);
            await targetRoom.permissionOverwrites
              .edit(fid, { ViewChannel: true, Connect: true })
              .catch(() => {});
          }
          roomInvitedFriends.set(targetRoom.id, invSet);
        }

        // Move the command user if they are in a voice channel and not already in targetRoom
        if (!alreadyInMatchingStudyRoom && member.voice.channelId) {
          await member.voice
            .setChannel(targetRoom, `Moved via /study ${subcommand}`)
            .catch((err) => {
              console.error('Failed to move member to study room:', err.message);
            });
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
            ? `\n🔔 **Invited to join ${targetRoom.name} (<#${targetRoom.id}>):** ${offlineVoiceFriends.join(', ')} *(click the room or button below to hop in!)*`
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
              invitedFriendIds: uniqueFriendIds,
              pomodoroOptions,
            });
            const joinRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`focus_startnow_${targetRoom.id}`)
                .setLabel('Start Study Session Now')
                .setEmoji('▶️')
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setLabel(
                  pomodoroOptions
                    ? `Click to Join ${targetRoom.name} (${pomodoroOptions.studyMinutes}m/${pomodoroOptions.breakMinutes}m × ${pomodoroOptions.totalRounds})`
                    : `Click to Join ${targetRoom.name} (${minutes}m Timer Ready)`
                )
                .setEmoji('🔊')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://discord.com/channels/${guild.id}/${targetRoom.id}`)
            );
            return interaction.editReply({
              content:
                pomodoroOptions
                  ? `✨ Created **${targetRoom.name}** (<#${targetRoom.id}>) with your **Pomodoro timer (${pomodoroOptions.studyMinutes}m study / ${pomodoroOptions.breakMinutes}m break × ${pomodoroOptions.totalRounds} rounds)** ready!${friendSummary}\n` +
                    `Click **🔊 Join** below to connect your voice (it will wait for everyone invited, or click **▶️ Start Study Session Now**):`
                  : `✨ Created **${targetRoom.name}** (<#${targetRoom.id}>) with your **${minutes}-minute** timer ready!${friendSummary}\n` +
                    `Click **🔊 Join** below to connect your voice (it will wait for everyone invited, or click **▶️ Start Study Session Now**):`,
              components: [joinRow],
            });
          } else if (paused && paused.remainingMs > 15000) {
            const minsLeft = Math.max(1, Math.ceil(paused.remainingMs / 60000));
            pendingRoomTimers.set(targetRoom.id, {
              userId: member.id,
              durationMs: paused.remainingMs,
              originalMinutes: paused.originalMinutes,
              isResumed: true,
              invitedFriendIds: uniqueFriendIds,
            });
            const joinRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`focus_startnow_${targetRoom.id}`)
                .setLabel('Start Study Session Now')
                .setEmoji('▶️')
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setLabel(`Click to Join ${targetRoom.name} (Resume ${minsLeft}m)`)
                .setEmoji('🔊')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://discord.com/channels/${guild.id}/${targetRoom.id}`)
            );
            return interaction.editReply({
              content:
                `🔄 Created **${targetRoom.name}** (<#${targetRoom.id}>) to resume your **${minsLeft} mins** left!${friendSummary}\n` +
                `Click **🔊 Join** below to hop in (or click **▶️ Start Study Session Now**):`,
              components: [joinRow],
            });
          } else {
            const promptPayload = buildPromptPayload(targetRoom, isSolo, true);
            await targetRoom.send(buildPromptPayload(targetRoom, isSolo, false)).catch(() => {});
            return interaction.editReply({
              content:
                `✨ Created **${targetRoom.name}** (<#${targetRoom.id}>)!${friendSummary}\nClick **🔊 Join ${targetRoom.name}** below (or <#${targetRoom.id}>), then pick your timer:`,
              ...promptPayload,
            });
          }
        }

        // At least 1 person IS in the Study Room voice channel now!
        // Check if we still need to wait for invited friends before starting the countdown timer
        const readiness = checkRoomReadyToStart(refreshedRoom);
        const mustWaitForFriends = !readiness.ready || offlineVoiceFriends.length > 0;
        const totalExpectedCount = uniqueFriendIds.length > 0 ? uniqueFriendIds.length + 1 : readiness.totalExpected;
        const presentInVoiceCount = Math.min(totalExpectedCount, Math.max(1, 1 + movedFriends.length));

        if (minutes) {
          if (mustWaitForFriends) {
            pendingRoomTimers.set(targetRoom.id, {
              userId: member.id,
              durationMs: minutes * 60 * 1000,
              originalMinutes: minutes,
              isResumed: false,
              invitedFriendIds: uniqueFriendIds,
              pomodoroOptions,
            });
            await setVoiceChannelStatus(
              targetRoom.id,
              `⏳ Waiting for friends (${presentInVoiceCount}/${totalExpectedCount} joined)...`
            );
            const joinRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`focus_startnow_${targetRoom.id}`)
                .setLabel('Start Study Session Now')
                .setEmoji('▶️')
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setLabel(
                  pomodoroOptions
                    ? `Join ${targetRoom.name} (${pomodoroOptions.studyMinutes}m/${pomodoroOptions.breakMinutes}m × ${pomodoroOptions.totalRounds})`
                    : `Join ${targetRoom.name} (${minutes}m Timer Waiting)`
                )
                .setEmoji('🔊')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://discord.com/channels/${guild.id}/${targetRoom.id}`)
            );
            await targetRoom
              .send({
                content: pomodoroOptions
                  ? `⏳ **Waiting for all invited friends to join before starting Pomodoro (${pomodoroOptions.studyMinutes}m study / ${pomodoroOptions.breakMinutes}m break × ${pomodoroOptions.totalRounds} rounds)!** (${presentInVoiceCount}/${totalExpectedCount} in voice — or click **▶️ Start Study Session Now** below to start without waiting)`
                  : `⏳ **Waiting for all invited friends to join before starting the ${minutes}-minute timer!** (${presentInVoiceCount}/${totalExpectedCount} in voice — or click **▶️ Start Study Session Now** below to start without waiting)`,
                components: [joinRow],
              })
              .catch(() => {});
            return interaction.editReply({
              content:
                `⏳ Moved to **${targetRoom.name}** (<#${targetRoom.id}>)!${friendSummary}\n` +
                (pomodoroOptions
                  ? `⏱️ Your **Pomodoro timer (${pomodoroOptions.studyMinutes}m study / ${pomodoroOptions.breakMinutes}m break × ${pomodoroOptions.totalRounds} rounds)** is waiting until **everyone invited (${presentInVoiceCount}/${totalExpectedCount})** joins — or click **▶️ Start Study Session Now** below to start immediately:`
                  : `⏱️ Your **${minutes}-minute** timer is waiting until **everyone invited (${presentInVoiceCount}/${totalExpectedCount})** joins — or click **▶️ Start Study Session Now** below to start immediately:`),
              components: [joinRow],
            });
          }

          const res = await startFocusSession(
            guild,
            targetRoom,
            breakChannel,
            minutes * 60 * 1000,
            interaction.user,
            false,
            minutes,
            uniqueFriendIds,
            pomodoroOptions
          );
          if (!res.ok) {
            return interaction.editReply(`❌ ${res.error}`);
          }
          const components = [];
          if (offlineVoiceFriends.length > 0) {
            components.push(
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setLabel(`Join ${targetRoom.name}`)
                  .setEmoji('🔊')
                  .setStyle(ButtonStyle.Link)
                  .setURL(`https://discord.com/channels/${guild.id}/${targetRoom.id}`)
              )
            );
          }
          return interaction.editReply({
            content: pomodoroOptions
              ? `🍅 Moved to **${targetRoom.name}** (<#${targetRoom.id}>) and started **Pomodoro Round 1/${pomodoroOptions.totalRounds}** (${pomodoroOptions.studyMinutes}m study / ${pomodoroOptions.breakMinutes}m break)!${friendSummary}`
              : `🔒 Moved to **${targetRoom.name}** (<#${targetRoom.id}>) and locked in a **${minutes}-minute** focus session!${friendSummary}`,
            components,
          });
        } else if (paused && paused.remainingMs > 15000) {
          const minsLeft = Math.max(1, Math.ceil(paused.remainingMs / 60000));
          if (!readiness.ready) {
            pendingRoomTimers.set(targetRoom.id, {
              userId: member.id,
              durationMs: paused.remainingMs,
              originalMinutes: paused.originalMinutes,
              isResumed: true,
              invitedFriendIds: uniqueFriendIds,
            });
            await setVoiceChannelStatus(
              targetRoom.id,
              `⏳ Waiting for friends (${readiness.presentCount}/${readiness.totalExpected} joined)...`
            );
            const joinRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`focus_startnow_${targetRoom.id}`)
                .setLabel('Start Study Session Now')
                .setEmoji('▶️')
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setLabel(`Join ${targetRoom.name} (Resume ${minsLeft}m)`)
                .setEmoji('🔊')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://discord.com/channels/${guild.id}/${targetRoom.id}`)
            );
            return interaction.editReply({
              content:
                `⏳ Moved to **${targetRoom.name}** (<#${targetRoom.id}>)!${friendSummary}\n` +
                `🔄 Your paused session (**${minsLeft} mins** left) will **resume automatically** once your invited friend(s) join (${readiness.presentCount}/${readiness.totalExpected} here) — or click **Start Study Session Now**:`,
              components: [joinRow],
            });
          }

          const res = await startFocusSession(
            guild,
            targetRoom,
            breakChannel,
            paused.remainingMs,
            interaction.user,
            true,
            paused.originalMinutes,
            uniqueFriendIds
          );
          if (!res.ok) {
            return interaction.editReply(`❌ ${res.error}`);
          }
          return interaction.editReply(
            `🔄 Moved to **${targetRoom.name}** (<#${targetRoom.id}>) and resumed your previous focus session (**${minsLeft} mins** left)!${friendSummary}`
          );
        } else {
          const promptPayload = buildPromptPayload(targetRoom, isSolo, offlineVoiceFriends.length > 0);
          await targetRoom.send(buildPromptPayload(targetRoom, isSolo, false)).catch(() => {});
          return interaction.editReply({
            content: `✅ Moved into **${targetRoom.name}** (<#${targetRoom.id}>)!${friendSummary}\nPick your focus timer below:`,
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

      // Start Study Session Now Button: focus_startnow_<channelId>
      if (customId.startsWith('focus_startnow_')) {
        const targetChannelId = customId.split('_')[2] || (member.voice && member.voice.channelId);
        const studyChannel = guild.channels.cache.get(targetChannelId);

        if (!studyChannel) {
          return interaction.reply({
            content: '❌ That Study Room no longer exists.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (activeSessions.has(studyChannel.id)) {
          return interaction.reply({
            content: 'ℹ️ The focus session is already running in this room!',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (member.voice.channelId && member.voice.channelId !== studyChannel.id) {
          await member.voice.setChannel(studyChannel, 'Starting focus session now').catch(() => {});
        }

        const pending = pendingRoomTimers.get(studyChannel.id);
        pendingRoomTimers.delete(studyChannel.id);

        const invitedSet = roomInvitedFriends.get(studyChannel.id);
        const invitedFriendIds =
          pending && pending.invitedFriendIds
            ? pending.invitedFriendIds
            : invitedSet
              ? Array.from(invitedSet)
              : [];

        const durationMs = pending ? pending.durationMs : 20 * 60 * 1000;
        const originalMinutes = pending ? pending.originalMinutes : 20;
        const isResumed = pending ? pending.isResumed : false;
        const pomodoroOptions = pending ? pending.pomodoroOptions : null;

        await interaction.deferUpdate();
        const refreshedStudyChannel = await guild.channels
          .fetch(studyChannel.id)
          .catch(() => studyChannel);
        const res = await startFocusSession(
          guild,
          refreshedStudyChannel,
          breakChannel,
          durationMs,
          interaction.user,
          isResumed,
          originalMinutes,
          invitedFriendIds,
          pomodoroOptions
        );
        if (!res.ok) {
          await interaction.followUp({
            content: `❌ ${res.error}`,
            flags: MessageFlags.Ephemeral,
          });
        }
        return;
      }

      // Skip Pomodoro Break Button: pomo_skipbreak_<channelId>
      if (customId.startsWith('pomo_skipbreak_')) {
        const targetChannelId = customId.split('_')[2];
        const session = activeSessions.get(targetChannelId);
        if (!session) {
          return interaction.reply({
            content: 'ℹ️ This study session has already ended.',
            flags: MessageFlags.Ephemeral,
          });
        }
        const isParticipant = session.participants.has(member.id);
        const isAdmin = member.permissions.has(PermissionFlagsBits.MoveMembers);
        if (!isParticipant && !isAdmin) {
          return interaction.reply({
            content: '❌ Only session participants can skip the break!',
            flags: MessageFlags.Ephemeral,
          });
        }
        await interaction.deferUpdate();
        await resumePomodoroStudy(targetChannelId);
        return;
      }

      // Extend Pomodoro Break Button: pomo_extendbreak_<channelId>
      if (customId.startsWith('pomo_extendbreak_')) {
        const targetChannelId = customId.split('_')[2];
        const session = activeSessions.get(targetChannelId);
        if (!session || session.phase !== 'break') {
          return interaction.reply({
            content: 'ℹ️ No active break is running for this session.',
            flags: MessageFlags.Ephemeral,
          });
        }
        const isParticipant = session.participants.has(member.id);
        const isAdmin = member.permissions.has(PermissionFlagsBits.MoveMembers);
        if (!isParticipant && !isAdmin) {
          return interaction.reply({
            content: '❌ Only session participants can extend the break!',
            flags: MessageFlags.Ephemeral,
          });
        }

        clearTimeout(session.timeoutId);
        session.breakMinutes = (session.breakMinutes || 5) + 5;
        const newEndTime = Math.max(Date.now(), session.endTime) + 5 * 60 * 1000;
        session.endTime = newEndTime;
        const remainingMs = newEndTime - Date.now();
        const minsLeft = Math.max(1, Math.ceil(remainingMs / 60000));
        const endSec = Math.floor(newEndTime / 1000);

        session.timeoutId = setTimeout(() => {
          resumePomodoroStudy(session.studyChannelId);
        }, remainingMs);

        const roomIdsToProcess = session.allRoomIds ? Array.from(session.allRoomIds) : [session.studyChannelId];
        for (const rId of roomIdsToProcess) {
          await setVoiceChannelStatus(
            rId,
            formatPomoBreakStatus(session.currentRound, session.totalRounds, minsLeft)
          );
        }

        return interaction.reply({
          content: `⏳ <@${member.id}> extended the break by **+5 minutes**! Break now ends <t:${endSec}:R> (at <t:${endSec}:t>).`,
        });
      }

      // Skip to Pomodoro Break Early Button: pomo_skiptobreak_<channelId>
      if (customId.startsWith('pomo_skiptobreak_')) {
        const targetChannelId = customId.split('_')[2];
        const session = activeSessions.get(targetChannelId);
        if (!session) {
          return interaction.reply({
            content: 'ℹ️ This study session has already ended.',
            flags: MessageFlags.Ephemeral,
          });
        }
        const isParticipant = session.participants.has(member.id);
        const isAdmin = member.permissions.has(PermissionFlagsBits.MoveMembers);
        if (!isParticipant && !isAdmin) {
          return interaction.reply({
            content: '❌ Only session participants can skip to break!',
            flags: MessageFlags.Ephemeral,
          });
        }
        await interaction.deferUpdate();
        await transitionToPomodoroBreak(targetChannelId);
        return;
      }

      // Pomodoro Preset Button: pomo_<studyMin>_<breakMin>_<rounds>_<channelId>
      if (customId.startsWith('pomo_') && !customId.startsWith('pomo_skip')) {
        const parts = customId.split('_');
        const studyMin = parseInt(parts[1], 10);
        const breakMin = parseInt(parts[2], 10);
        const rounds = parseInt(parts[3], 10);
        const targetChannelId = parts[4] || (member.voice && member.voice.channelId);
        const studyChannel = guild.channels.cache.get(targetChannelId);

        if (!studyChannel) {
          return interaction.reply({
            content: '❌ That Study Room no longer exists.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (member.voice.channelId && member.voice.channelId !== studyChannel.id) {
          await member.voice.setChannel(studyChannel, 'Starting Pomodoro session').catch(() => {});
        }

        const invitedSet = roomInvitedFriends.get(studyChannel.id);
        const invitedFriendIds = invitedSet ? Array.from(invitedSet) : [];

        const pomodoroOptions = {
          isPomodoro: true,
          studyMinutes: studyMin,
          breakMinutes: breakMin,
          totalRounds: rounds,
          currentRound: 1,
        };

        if (!member.voice.channelId) {
          pendingRoomTimers.set(studyChannel.id, {
            userId: member.id,
            durationMs: studyMin * 60 * 1000,
            originalMinutes: studyMin,
            isResumed: false,
            invitedFriendIds,
            pomodoroOptions,
          });
          const joinRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setLabel(`Click to Join ${studyChannel.name} (Pomodoro ${studyMin}m/${breakMin}m × ${rounds})`)
              .setEmoji('🔊')
              .setStyle(ButtonStyle.Link)
              .setURL(`https://discord.com/channels/${guild.id}/${studyChannel.id}`)
          );
          return interaction.reply({
            content: `⏳ **Pomodoro timer ready (${studyMin}m study / ${breakMin}m break × ${rounds} rounds)!** Click below to join <#${studyChannel.id}> and start:`,
            components: [joinRow],
            flags: MessageFlags.Ephemeral,
          });
        }

        const refreshedStudyChannel = await guild.channels
          .fetch(studyChannel.id)
          .catch(() => studyChannel);
        const readiness = checkRoomReadyToStart(refreshedStudyChannel);

        if (!readiness.ready) {
          pendingRoomTimers.set(studyChannel.id, {
            userId: member.id,
            durationMs: studyMin * 60 * 1000,
            originalMinutes: studyMin,
            isResumed: false,
            invitedFriendIds,
            pomodoroOptions,
          });
          await setVoiceChannelStatus(
            studyChannel.id,
            `⏳ Waiting for friends (${readiness.presentCount}/${readiness.totalExpected} joined)...`
          );
          const startNowRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`focus_startnow_${studyChannel.id}`)
              .setLabel('Start Study Session Now')
              .setEmoji('▶️')
              .setStyle(ButtonStyle.Success)
          );
          return interaction.reply({
            content: `⏳ **Pomodoro (${studyMin}m / ${breakMin}m × ${rounds} rounds)** queued! Waiting for invited friend(s) to join <#${studyChannel.id}> (${readiness.presentCount}/${readiness.totalExpected} in voice) before starting, or click below:`,
            components: [startNowRow],
          });
        }

        await interaction.deferUpdate();
        const res = await startFocusSession(
          guild,
          refreshedStudyChannel,
          breakChannel,
          studyMin * 60 * 1000,
          interaction.user,
          false,
          studyMin,
          invitedFriendIds,
          pomodoroOptions
        );
        if (!res.ok) {
          await interaction.followUp({
            content: `❌ ${res.error}`,
            flags: MessageFlags.Ephemeral,
          });
        }
        return;
      }

      // Start Focus Button: focus_<minutes>_<channelId>
      if (
        customId.startsWith('focus_') &&
        !customId.startsWith('focus_unlock') &&
        !customId.startsWith('focus_startnow_')
      ) {
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

        const invitedSet = roomInvitedFriends.get(studyChannel.id);
        const invitedFriendIds = invitedSet ? Array.from(invitedSet) : [];

        if (!member.voice.channelId) {
          pendingRoomTimers.set(studyChannel.id, {
            userId: member.id,
            durationMs: minutes * 60 * 1000,
            originalMinutes: minutes,
            isResumed: false,
            invitedFriendIds,
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

        const refreshedStudyChannel = await guild.channels
          .fetch(studyChannel.id)
          .catch(() => studyChannel);
        const readiness = checkRoomReadyToStart(refreshedStudyChannel);

        if (!readiness.ready) {
          pendingRoomTimers.set(studyChannel.id, {
            userId: member.id,
            durationMs: minutes * 60 * 1000,
            originalMinutes: minutes,
            isResumed: false,
            invitedFriendIds,
          });
          await setVoiceChannelStatus(
            studyChannel.id,
            `⏳ Waiting for friends (${readiness.presentCount}/${readiness.totalExpected} joined)...`
          );
          const startNowRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`focus_startnow_${studyChannel.id}`)
              .setLabel('Start Study Session Now')
              .setEmoji('▶️')
              .setStyle(ButtonStyle.Success)
          );
          return interaction.reply({
            content: `⏳ **${minutes}-minute** timer is queued! Waiting for your invited friend(s) to join <#${studyChannel.id}> (${readiness.presentCount}/${readiness.totalExpected} in voice — needs at least ${readiness.requiredCount}) before the countdown starts, or click below to start now:`,
            components: [startNowRow],
          });
        }

        await interaction.deferUpdate();
        const res = await startFocusSession(
          guild,
          refreshedStudyChannel,
          breakChannel,
          minutes * 60 * 1000,
          interaction.user,
          false,
          minutes,
          invitedFriendIds
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
