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
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log("Slash commands registered.");
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

// ---------- Handle slash command + button interactions ----------
client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "start" && interaction.options.getSubcommand() === "giveaway") {
      await handleStartGiveaway(interaction);
    }
  } else if (interaction.isButton()) {
    if (interaction.customId.startsWith("join_giveaway_")) {
      await handleJoinButton(interaction);
    }
  }
});

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

  const embed = new EmbedBuilder()
    .setTitle(`🎉 Giveaway #${number} Started!`)
    .setDescription(
      `**Prize:** ${prize}\n` +
        `**Winners:** ${winnersCount}\n` +
        `**Hosted by:** <@${interaction.user.id}>\n` +
        `**Ends:** <t:${endTimestamp}:R>\n\n` +
        `Click the button below to enter!`
    )
    .setColor(0x5865f2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`join_giveaway_${number}`)
      .setLabel("🎉 Join Giveaway")
      .setStyle(ButtonStyle.Primary)
  );

  await interaction.reply({ embeds: [embed], components: [row] });
  const message = await interaction.fetchReply();

  activeGiveaways.set(message.id, {
    prize,
    winnersCount,
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
}

async function endGiveaway(message) {
  const giveaway = activeGiveaways.get(message.id);
  if (!giveaway) return;
  activeGiveaways.delete(message.id);

  const channel = await client.channels.fetch(giveaway.channelId);
  const entrants = Array.from(giveaway.entrants);

  // Disable the button
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
      .setDescription(`**Prize:** ${giveaway.prize}\nNo one entered — no winner this time.`)
      .setColor(0xed4245);
    return channel.send({ embeds: [noWinnerEmbed] });
  }

  const winnerCount = Math.min(giveaway.winnersCount, entrants.length);
  const shuffled = entrants.sort(() => 0.5 - Math.random());
  const winnerIds = shuffled.slice(0, winnerCount);
  const mentions = winnerIds.map((id) => `<@${id}>`).join(", ");

  const resultEmbed = new EmbedBuilder()
    .setTitle("🎉 Giveaway Ended!")
    .setDescription(`**Prize:** ${giveaway.prize}\n**Winner(s):** ${mentions}\n\nCongratulations!`)
    .setColor(0xf1c40f);
  await channel.send({ embeds: [resultEmbed] });

  // DM each winner
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

client.login(process.env.DISCORD_TOKEN);
