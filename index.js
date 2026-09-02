require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Routes,
  REST,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// In-memory store of active giveaways, keyed by message ID
const activeGiveaways = new Map();

// ---------- Slash command definition ----------
// Creates: /start giveaway number:<int> prize:<text> duration:<minutes> winners:<number>
const commands = [
  new SlashCommandBuilder()
    .setName("start")
    .setDescription("Start commands")
    .addSubcommand((sub) =>
      sub
        .setName("giveaway")
        .setDescription("Start a giveaway")
        .addIntegerOption((opt) =>
          opt
            .setName("number")
            .setDescription("Giveaway number/ID (useful if running several at once)")
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName("prize").setDescription("What are you giving away?").setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt.setName("duration").setDescription("Duration in minutes").setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt.setName("winners").setDescription("Number of winners (default 1)").setRequired(false)
        )
    ),
].map((cmd) => cmd.toJSON());

// ---------- Register slash commands on startup ----------
async function registerCommands() {
  try {
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("[startup] Slash commands registered successfully.");
  } catch (err) {
    console.error("[startup] FAILED to register slash commands:", err);
  }
}

client.once("ready", async () => {
  console.log(`[startup] Logged in as ${client.user.tag}`);
  await registerCommands();
});

// Catch errors explicitly instead of failing silently
client.on("error", (err) => {
  console.error("[client error]", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[unhandled rejection]", err);
});

// ---------- Handle slash command + button interactions ----------
client.on("interactionCreate", async (interaction) => {
  console.log(
    `[interaction] type=${interaction.type} name=${interaction.commandName ?? interaction.customId} user=${interaction.user?.tag}`
  );

  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "start" && interaction.options.getSubcommand() === "giveaway") {
        await handleStartGiveaway(interaction);
      }
    } else if (interaction.isButton()) {
      if (interaction.customId.startsWith("join_giveaway_")) {
        await handleJoinButton(interaction);
      }
    }
  } catch (err) {
    console.error("[interaction error]", err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: "Something went wrong running that command. Check the bot logs.", ephemeral: true })
        .catch(() => {});
    }
  }
});

function buildGiveawayEmbed({ number, prize, winnersCount, hostId, endTimestamp, entryCount }) {
  return new EmbedBuilder()
    .setTitle(`🎉 Giveaway #${number} Started!`)
    .setDescription(
      `**Prize:** ${prize}\n` +
        `**Winners:** ${winnersCount}\n` +
        `**Entries:** ${entryCount}\n` +
        `**Hosted by:** <@${hostId}>\n` +
        `**Ends:** <t:${endTimestamp}:R>\n\n` +
        `Click the button below to enter!`
    )
    .setColor(0x5865f2);
}

async function handleStartGiveaway(interaction) {
  const number = interaction.options.getInteger("number");
  const prize = interaction.options.getString("prize");
  const duration = interaction.options.getInteger("duration");
  const winnersCount = interaction.options.getInteger("winners") ?? 1;

  if (duration <= 0) {
    return interaction.reply({ content: "Duration must be at least 1 minute.", ephemeral: true });
  }
  if (winnersCount <= 0) {
    return interaction.reply({ content: "Winners must be at least 1.", ephemeral: true });
  }

  const endTimestamp = Math.floor(Date.now() / 1000) + duration * 60;
  const hostId = interaction.user.id;

  const embed = buildGiveawayEmbed({ number, prize, winnersCount, hostId, endTimestamp, entryCount: 0 });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`join_giveaway_${number}`)
      .setLabel("🎉 Join Giveaway")
      .setStyle(ButtonStyle.Primary)
  );

  await interaction.reply({ embeds: [embed], components: [row] });
  const message = await interaction.fetchReply();

  activeGiveaways.set(message.id, {
    number,
    prize,
    winnersCount,
    hostId,
    endTimestamp,
    entrants: new Set(),
    channelId: interaction.channelId,
    guildName: interaction.guild.name,
  });

  setTimeout(() => endGiveaway(message), duration * 60 * 1000);
}

async function handleJoinButton(interaction) {
  const giveaway = activeGiveaways.get(interaction.message.id);
  if (!giveaway) {
    return interaction.reply({ content: "This giveaway has ended.", ephemeral: true });
  }

  if (giveaway.entrants.has(interaction.user.id)) {
    giveaway.entrants.delete(interaction.user.id);
    await interaction.reply({ content: "You left the giveaway. Click again to rejoin.", ephemeral: true });
  } else {
    giveaway.entrants.add(interaction.user.id);
    await interaction.reply({
      content: `You're entered to win **${giveaway.prize}**! Good luck 🍀`,
      ephemeral: true,
    });
  }

  // Update the entry count shown on the giveaway embed
  const updatedEmbed = buildGiveawayEmbed({
    number: giveaway.number,
    prize: giveaway.prize,
    winnersCount: giveaway.winnersCount,
    hostId: giveaway.hostId,
    endTimestamp: giveaway.endTimestamp,
    entryCount: giveaway.entrants.size,
  });
  await interaction.message.edit({ embeds: [updatedEmbed] }).catch((err) => {
    console.error("[entry count update failed]", err);
  });
}

async function endGiveaway(message) {
  const giveaway = activeGiveaways.get(message.id);
  if (!giveaway) return;
  activeGiveaways.delete(message.id);

  const channel = await client.channels.fetch(giveaway.channelId);
  const entrants = Array.from(giveaway.entrants);

  try {
    const disabledRow = new ActionRowBuilder().addComponents(
      ButtonBuilder.from(message.components[0].components[0]).setDisabled(true)
    );
    await message.edit({ components: [disabledRow] });
  } catch (err) {
    // message may be too old to edit; ignore
  }

  if (entrants.length === 0) {
    const noWinnerEmbed = new EmbedBuilder()
      .setTitle("🎉 Giveaway Ended")
      .setDescription(`**Prize:** ${giveaway.prize}\n**Entries:** 0\nNo one entered — no winner this time.`)
      .setColor(0xed4245);
    return channel.send({ embeds: [noWinnerEmbed] });
  }

  const winnerCount = Math.min(giveaway.winnersCount, entrants.length);
  const shuffled = entrants.sort(() => 0.5 - Math.random());
  const winnerIds = shuffled.slice(0, winnerCount);
  const mentions = winnerIds.map((id) => `<@${id}>`).join(", ");

  const resultEmbed = new EmbedBuilder()
    .setTitle("🎉 Giveaway Ended!")
    .setDescription(
      `**Prize:** ${giveaway.prize}\n**Entries:** ${entrants.length}\n**Winner(s):** ${mentions}\n\nCongratulations!`
    )
    .setColor(0xf1c40f);
  await channel.send({ embeds: [resultEmbed] });

  for (const id of winnerIds) {
    try {
      const user = await client.users.fetch(id);
      const dmEmbed = new EmbedBuilder()
        .setTitle("🎉 You Won!")
        .setDescription(`Congrats! You won **${giveaway.prize}** in the giveaway on **${giveaway.guildName}**!`)
        .setColor(0xf1c40f);
      await user.send({ embeds: [dmEmbed] });
    } catch (err) {
      await channel.send(`⚠️ Couldn't DM <@${id}> (DMs closed) — congrats anyway!`);
    }
  }
}

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error("[startup] FAILED to log in:", err);
});
