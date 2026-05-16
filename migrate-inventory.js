/**
 * migrate-inventory.js — One-time migration: UserInventory → InventoryItem
 *
 * Run ONCE before deploying the unified inventory update:
 *   node migrate-inventory.js
 *
 * WHAT IT DOES:
 *   - Reads all UserInventory documents
 *   - Maps each embedded item to InventoryItem format
 *   - Uses upsert to avoid duplicates (safe to re-run)
 *   - Migrated documents get source='purchased' (materials) or 'crafted' (crafted items)
 *   - craftId is preserved in sourceRef for backward lookup compatibility
 *
 * FIELD MAPPING:
 *   Old UserInventory item            → New InventoryItem
 *   ─────────────────────────────────────────────────────
 *   name                              → itemType
 *   multiplier (1/1.5/2/3)           → grade (standard/premium/military/prototype)
 *   craftId != null                   → source = 'crafted', sourceRef = craftId
 *   craftId == null                   → source = 'purchased'
 *   category (raw/food/etc)          → (dropped; implied by itemType name)
 *   customName                        → (dropped; was display-only)
 *   originGuildId                     → (dropped; guildId from parent doc)
 *
 * SAFE TO RE-RUN: uses findOneAndUpdate with upsert — quantities are NOT
 * double-added on re-run. If a stack already exists, it is left untouched
 * (setOnInsert only).
 *
 * ORG/CULT STORAGE:
 *   org.inventory and cult.inventory are embedded arrays in Mongoose docs.
 *   This script migrates them in-place to the new { itemType, grade, ... } format.
 */

require('dotenv').config();
const mongoose    = require('mongoose');
const UserInventory = require('./src/models/UserInventory');
const InventoryItem = require('./src/models/InventoryItem');
const Organization  = require('./src/models/Organization');
const Cult          = require('./src/models/Cult');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('ERROR: MONGO_URI not set in environment.');
  process.exit(1);
}

const MULTIPLIER_TO_GRADE = {
  1: 'standard', 1.0: 'standard',
  1.5: 'premium',
  2: 'military', 2.0: 'military',
  3: 'prototype', 3.0: 'prototype',
};

function toGrade(multiplier) {
  return MULTIPLIER_TO_GRADE[multiplier] ?? 'standard';
}

/**
 * Migrate a single embedded old-style item to InventoryItem upsert params.
 */
function mapItem(oldItem, userId, guildId) {
  const isCrafted = !!oldItem.craftId;
  return {
    filter: {
      userId,
      guildId,
      itemType: oldItem.name,
      grade:    toGrade(oldItem.multiplier ?? 1),
      source:   isCrafted ? 'crafted' : 'purchased',
    },
    update: {
      $setOnInsert: {
        userId,
        guildId,
        itemType:     oldItem.name,
        grade:        toGrade(oldItem.multiplier ?? 1),
        quantity:     oldItem.quantity ?? 1,
        itemValueUEC: 0,  // old system didn't track value; default 0
        source:       isCrafted ? 'crafted' : 'purchased',
        sourceRef:    oldItem.craftId ?? null,
        createdAt:    oldItem.craftedAt ?? new Date(),
        updatedAt:    new Date(),
      },
      // Only increment quantity when merging an existing stack with same craftId
      // To avoid double-counting on re-run, we use $setOnInsert for quantity too.
    },
  };
}

/**
 * Migrate org/cult embedded inventory arrays in-place.
 * Replaces old-format items (name/itemId/craftId) with new format (itemType/grade).
 */
function migrateStorageArray(items) {
  return items.map(item => {
    // Already migrated format
    if (item.itemType) return item;

    const isCrafted = !!item.craftId;
    return {
      itemType:     item.name || item.itemId,
      grade:        toGrade(item.multiplier ?? 1),
      quantity:     item.quantity ?? 1,
      itemValueUEC: 0,
      source:       isCrafted ? 'crafted' : 'purchased',
      sourceRef:    item.craftId ?? null,
      depositedBy:  item.depositedBy ?? null,
      depositedAt:  item.depositedAt ?? new Date(),
    };
  });
}

async function run() {
  console.log('Connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log('Connected.\n');

  // ── 1. Migrate UserInventory → InventoryItem ─────────────────────────────
  console.log('Step 1: Migrating UserInventory documents…');
  const inventories = await UserInventory.find({}).lean();
  console.log(`  Found ${inventories.length} UserInventory documents.`);

  let migrated = 0, skipped = 0, errors = 0;

  for (const inv of inventories) {
    for (const oldItem of inv.items) {
      if (!oldItem.name) { skipped++; continue; }
      const { filter, update } = mapItem(oldItem, inv.userId, inv.guildId);
      try {
        await InventoryItem.findOneAndUpdate(filter, update, { upsert: true });
        migrated++;
      } catch (err) {
        // Duplicate key on unique index means stack already exists — skip safely
        if (err.code === 11000) { skipped++; }
        else { console.error(`  ERROR for ${inv.userId}/${inv.guildId}/${oldItem.name}:`, err.message); errors++; }
      }
    }
  }

  console.log(`  Migrated: ${migrated} | Skipped (already exist): ${skipped} | Errors: ${errors}\n`);

  // ── 2. Migrate Org embedded inventories ──────────────────────────────────
  console.log('Step 2: Migrating Organization embedded inventories…');
  const orgs = await Organization.find({ 'inventory.0': { $exists: true } });
  console.log(`  Found ${orgs.length} orgs with inventory items.`);

  let orgMigrated = 0;
  for (const org of orgs) {
    const before = JSON.stringify(org.inventory[0]);
    org.inventory = migrateStorageArray(org.inventory);
    if (JSON.stringify(org.inventory[0]) !== before) {
      org.markModified('inventory');
      await org.save();
      orgMigrated++;
    }
  }
  console.log(`  Migrated: ${orgMigrated} orgs.\n`);

  // ── 3. Migrate Cult embedded inventories ─────────────────────────────────
  console.log('Step 3: Migrating Cult embedded inventories…');
  const cults = await Cult.find({ 'inventory.0': { $exists: true } });
  console.log(`  Found ${cults.length} cults with inventory items.`);

  let cultMigrated = 0;
  for (const cult of cults) {
    const before = JSON.stringify(cult.inventory[0]);
    cult.inventory = migrateStorageArray(cult.inventory);
    if (JSON.stringify(cult.inventory[0]) !== before) {
      cult.markModified('inventory');
      await cult.save();
      cultMigrated++;
    }
  }
  console.log(`  Migrated: ${cultMigrated} cults.\n`);

  console.log('Migration complete!');
  console.log('');
  console.log('NEXT STEPS:');
  console.log('  1. Deploy the updated bot code.');
  console.log('  2. Monitor for any inventory errors in logs.');
  console.log('  3. After confirming everything works, you can archive UserInventory.');
  console.log('     (Do NOT drop the collection until you are confident — it is a safety net.)');

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
