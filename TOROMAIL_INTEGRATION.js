/**
 * INDEX.JS INTEGRATION PATCH
 * ===========================
 *
 * The ToroMail + Org/Cult integration is fully self-contained — the new files
 * wire up automatically through the existing command loaders in index.js.
 *
 * No changes to index.js are REQUIRED. However, confirm the following:
 *
 * ── 1. interactionCreate handler covers BUTTON interactions ─────────────────
 *
 * The existing handler in index.js only handles `isChatInputCommand()`.
 * The mail-inbox uses buttons inside DM channels (not slash commands),
 * so buttons are handled by Discord.js collectors — no global handler needed.
 *
 * If you ever add global button routing, add this guard:
 *
 *   client.on('interactionCreate', async (interaction) => {
 *     if (interaction.isButton()) {
 *       // buttons from mail-inbox, org invite, cult invite are all
 *       // handled by per-message collectors — nothing to add here
 *       return;
 *     }
 *     // ... your existing slash command handler
 *   });
 *
 * ── 2. New slash command auto-loads ─────────────────────────────────────────
 *
 * src/slashCommands/mail.js is picked up automatically by the existing
 * slashFiles loader loop in index.js. No edits needed.
 *
 * ── 3. New prefix command auto-loads ────────────────────────────────────────
 *
 * src/prefixCommands/mail-inbox.js is picked up automatically by the
 * prefixFiles loader loop. No edits needed.
 *
 * ── 4. Updated commands replace old ones ────────────────────────────────────
 *
 * src/prefixCommands/org.js   — replaces old org.js (ToroMail integrated)
 * src/prefixCommands/cult.js  — replaces old cult.js (ToroMail integrated)
 *
 * Both files are drop-in replacements with identical command names/aliases.
 *
 * ── 5. New MongoDB collection ────────────────────────────────────────────────
 *
 * ToroMail messages are stored in a new `toromails` collection.
 * Mongoose creates it automatically on first write — no migration needed.
 *
 * RECOMMENDED: Add a MongoDB index for performance (run once in Mongo shell):
 *
 *   db.toromails.createIndex({ receiverId: 1, deleted: 1, sentAt: -1 });
 *   db.toromails.createIndex({ senderId: 1 });
 *
 * These are also declared in the Mongoose schema so they'll be created
 * automatically via ensureIndexes on startup.
 */
