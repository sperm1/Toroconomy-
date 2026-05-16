require('dotenv').config();
const { Client, GatewayIntentBits, Collection, REST, Routes, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const express = require('express');
const GuildSettings = require('./src/models/GuildSettings');

// ========== UPTIME SERVER ==========
const app = express();
app.get('/', (req, res) => res.send('Toroconomy $ is online!'));
app.listen(3000, () => console.log('Uptime server running on port 3000'));

// ========== DATABASE ==========
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected!'))
  .catch(err => console.error('❌ MongoDB failed:', err.message));

// ========== CLIENT ==========
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ]
});

// ========== COLLECTIONS ==========
client.prefixCommands = new Collection();
client.slashCommands = new Collection();

// ========== LOAD PREFIX COMMANDS ==========
const prefixPath = path.join(__dirname, 'src', 'prefixCommands');
const prefixFiles = fs.readdirSync(prefixPath).filter(f => f.endsWith('.js'));
for (const file of prefixFiles) {
  const cmd = require(path.join(prefixPath, file));
  client.prefixCommands.set(cmd.name, cmd);
  console.log(`Loaded prefix command: ${cmd.name}`);
}

// ========== LOAD SLASH COMMANDS ==========
const slashPath = path.join(__dirname, 'src', 'slashCommands');
const slashFiles = fs.readdirSync(slashPath).filter(f => f.endsWith('.js'));
const slashData = [];
for (const file of slashFiles) {
  const cmd = require(path.join(slashPath, file));
  client.slashCommands.set(cmd.data.name, cmd);
  slashData.push(cmd.data.toJSON());
  console.log(`Loaded slash command: ${cmd.data.name}`);
}

// ========== NEW COMMAND ROUTERS (Phases 3–7) ==========
// Single entry point that chains: material shop → phase 6 → phase 5 → phase 3/4
const { handleAll: handleNewCommands } = require('./src/commands/material');

// ========== READY ==========
const { startMaterialRestockTask } = require('./src/tasks/materialRestockTask');

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Register slash commands globally
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: slashData });
  console.log('✅ Slash commands registered!');

  // Start material restock background task
  startMaterialRestockTask();
  console.log('✅ Material restock task started!');
});

const XMARK = '<:xmark:1502545493807599636>';

// Prefix command names/aliases that are allowed in DMs
const DM_ALLOWED_COMMANDS = new Set(['mail-inbox', 'mailinbox', 'inbox']);

// Slash command names that are allowed in DMs
const DM_ALLOWED_SLASH = new Set(['mail', 'mail-inbox']);

// Commands that are always allowed in a server even before setup
const SETUP_EXEMPT_COMMANDS = new Set(['setup', 'help', 'ping', 'h', 'commands']);

// ========== PREFIX COMMAND HANDLER ==========
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // ── DM handling: only mail commands are allowed ──────────────────────────
  if (!message.guild) {
    const dmPrefix = '!';
    if (!message.content.startsWith(dmPrefix)) return;
    const dmArgs = message.content.slice(dmPrefix.length).trim().split(/ +/);
    const dmCommandName = dmArgs.shift().toLowerCase();

    if (!DM_ALLOWED_COMMANDS.has(dmCommandName)) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xef4444)
            .setDescription(`${XMARK} Commands can only be used in a server.\nThe only commands available in DMs are mail commands: \`!inbox\` / \`!mail-inbox\``),
        ],
      });
    }
    // Fall through to execute the mail command in DM context
  }

  // ── Get guild settings ───────────────────────────────────────────────────
  let settings = message.guild
    ? await GuildSettings.findOne({ guildId: message.guild.id })
    : null;
  const prefix = settings?.prefix || '!';

  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const commandName = args.shift().toLowerCase();

  // ── Setup check: block all guild commands if server hasn't been set up ───
  if (message.guild && !settings?.setupDone && !SETUP_EXEMPT_COMMANDS.has(commandName)) {
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle(`${XMARK} Server Not Set Up`)
          .setDescription(
            `This server hasn't been configured yet.\n\nAn admin needs to run **\`/setup\`** before any commands can be used.`
          )
          .setFooter({ text: 'Only admins with Manage Server permission can run /setup' }),
      ],
    });
  }

  // ── Try new phase routers first (phases 3–7) ──────────────────────────────
  // Skip these in DMs — they require guild context; only mail commands reach here in DMs.
  if (message.guild) {
    const handled = await handleNewCommands(commandName, message, args).catch(err => {
      console.error(`Error in new command router [${commandName}]:`, err);
      message.reply('❌ Something went wrong! Please try again.');
      return true;
    });
    if (handled) return;
  }

  // ── Fall through to base prefix commands ──────────────────────────────────
  const command = client.prefixCommands.get(commandName)
    || client.prefixCommands.find(c => c.aliases && c.aliases.includes(commandName));

  if (!command) {
    return message.reply(`❌ Unknown command: \`${prefix}${commandName}\`. Type \`${prefix}help\` to see all available commands.`);
  }

  try {
    await command.execute(message, args, client);
  } catch (error) {
    console.error(`Error in command ${commandName}:`, error);
    message.reply('❌ Something went wrong! Please try again.');
  }
});

// ========== SLASH COMMAND HANDLER ==========
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.slashCommands.get(interaction.commandName);
  if (!command) return;

  // ── DM check: only mail slash commands allowed outside a server ───────────
  if (!interaction.guild && !DM_ALLOWED_SLASH.has(interaction.commandName)) {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xef4444)
          .setDescription(`${XMARK} Slash commands can only be used in a server.\nThe only commands available in DMs are \`/mail\` and \`/mail-inbox\`.`),
      ],
      ephemeral: true,
    });
  }

  // ── Setup check for slash commands ───────────────────────────────────────
  if (interaction.guild) {
    const settings = await GuildSettings.findOne({ guildId: interaction.guild.id });
    const isSetupExempt = ['setup', 'help', 'ping'].includes(interaction.commandName);
    if (!settings?.setupDone && !isSetupExempt) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xef4444)
            .setTitle(`${XMARK} Server Not Set Up`)
            .setDescription(
              `This server hasn't been configured yet.\n\nAn admin needs to run **\`/setup\`** before any commands can be used.`
            )
            .setFooter({ text: 'Only admins with Manage Server permission can run /setup' }),
        ],
        ephemeral: true,
      });
    }
  }

  try {
    await command.execute(interaction, client);
  } catch (error) {
    console.error(`Error in slash command ${interaction.commandName}:`, error);
    interaction.reply({ content: '❌ Something went wrong!', ephemeral: true });
  }
});

// ========== LOGIN ==========
client.login(process.env.DISCORD_TOKEN);
