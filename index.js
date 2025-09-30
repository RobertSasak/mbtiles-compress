import { createHash } from 'crypto'
import Database from 'better-sqlite3'
import sharp from 'sharp'

/**
 * Compute MD5 hex digest of a Buffer
 * @param {Buffer} buffer - Image buffer
 * @returns {string} md5 hex string
 */
function md5_hex(buffer) {
  return createHash('md5').update(buffer).digest('hex')
}

/**
 * Compress a single tile's raw data buffer
 * @param {Buffer} tileData - Raw image tile buffer
 * @param {number} quality - WebP compression quality (0-100)
 * @param {number} alphaQuality - WebP alpha quality (0-100)
 * @param {number} method - WebP compression method (0-6)
 * @returns {Promise<Buffer>} Compressed tile data
 */
async function compressTile(tileData, quality, alphaQuality, method) {
  return await sharp(tileData)
    .webp({ quality, alphaQuality, effort: method })
    .toBuffer()
}

/**
 * Compresses an MBTiles file using WebP compression.
 *
 * @param {string} source - Path to source MBTiles file
 * @param {string} destination - Path to output compressed MBTiles file
 * @param {number} quality - WebP compression quality (0-100)
 * @param {number} alphaQuality - WebP alpha quality (0-100)
 * @param {number} method - WebP compression method (0-6)
 * @param {number} concurrency - Number of parallel compression operations
 * @param {boolean} [skipCount=false] - If true, skip counting rows and progress reporting
 * @returns {Promise<void>} Resolves when compression is complete
 */
async function run(
  source,
  destination,
  quality,
  alphaQuality,
  method,
  concurrency,
  skipCount = false
) {
  const sourceDb = new Database(source, { readonly: true })
  const destDb = new Database(destination)
  try {
    destDb.pragma('journal_mode = WAL')

    console.log('Copying MBTiles structure')
    const objects = sourceDb
      .prepare(`SELECT name, type, sql FROM sqlite_master`)
      .all()

    // Create all tables
    for (const { sql, type } of objects) {
      if (type == 'table' && sql) {
        destDb.exec(sql)
      }
    }

    // Attach and copy all tables except images and map
    destDb.exec(`ATTACH DATABASE '${source}' AS source`)
    for (const { name, type } of objects) {
      if (type === 'table' && name !== 'images' && name !== 'map') {
        destDb.exec(`INSERT INTO ${name} SELECT * FROM source.${name}`)
      }
    }
    destDb.exec(`DETACH DATABASE source`)

    console.log('Creating indexes and view')
    for (const { sql, type } of objects) {
      if (type !== 'table' && sql) {
        destDb.exec(sql)
      }
    }

    let totalCount = undefined
    if (!skipCount) {
      totalCount = sourceDb
        .prepare(`SELECT COUNT(*) as count FROM map`)
        .get().count
      console.log(`Found ${totalCount} image tiles to compress`)
    }

    let processed = 0
    let failed = 0
    const activePromises = new Set()

    const insertImage = destDb.prepare(
      `INSERT OR IGNORE INTO images (tile_id, tile_data) VALUES (?, ?)`
    )
    const insertMap = destDb.prepare(
      `INSERT INTO map (zoom_level, tile_column, tile_row, tile_id, grid_id) VALUES (?, ?, ?, ?, null)`
    )
    const tiles = sourceDb
      .prepare(`SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles`)
      .raw()
      .iterate()

    console.log('Compressing image tiles')

    for (const [zoom_level, tile_column, tile_row, tile_data] of tiles) {
      if (activePromises.size >= concurrency) {
        await Promise.race(activePromises)
      }

      const compressionPromise = compressTile(
        tile_data,
        quality,
        alphaQuality,
        method
      )
        .then(async (compressedData) => {
          const newTileId = md5_hex(compressedData)
          await Promise.all([
            insertImage.run(newTileId, compressedData),
            insertMap.run(zoom_level, tile_column, tile_row, newTileId),
          ])
        })
        .catch(({ message }) => {
          console.warn(
            `Failed to compress tile ${zoom_level}, ${tile_column}, ${tile_row}: ${message}`
          )
          failed++
        })
        .finally(() => {
          processed++
          if (processed % 100 === 0) {
            console.log(
              `Processed ${processed}${
                totalCount ? '/' + totalCount : ''
              } image tiles`
            )
          }
          activePromises.delete(compressionPromise)
        })
      activePromises.add(compressionPromise)
    }
    await Promise.all(activePromises)

    console.log(`Successfully processed ${processed} image tiles.`)
    if (failed > 0) {
      console.log(
        '\x1b[33m%s\x1b[0m',
        `Warning: ${failed} tiles failed to compress and were skipped.`
      )
    }

    console.log('Optimizing destination database')
    destDb.exec('PRAGMA optimize')
    destDb.exec('ANALYZE')
    destDb.exec('VACUUM')
    console.log('Compression completed successfully!')
  } finally {
    sourceDb.close()
    destDb.close()
  }
}

export { compressTile, md5_hex, run }
