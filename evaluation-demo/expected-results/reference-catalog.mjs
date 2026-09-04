export function migrateCatalog(legacyCatalog) {
  return legacyCatalog.items
    .filter((item) => item.active)
    .map((item) => ({
      sku: item.legacySku,
      name: item.name,
      slug: item.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      price_cents: Math.round(Number(item.price) * 100),
      image_count: item.imagePaths.length
    }))
    .sort((left, right) => left.sku.localeCompare(right.sku));
}
