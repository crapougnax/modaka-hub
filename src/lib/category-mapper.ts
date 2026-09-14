import * as path from 'node:path';

/**
 * Directory-based category mapping rules.
 *
 * Order matters: first match wins. Paths are normalised and compared
 * case-insensitively against the relative path from the scan root.
 */
const DIRECTORY_RULES: Array<{ pattern: string; category: string }> = [
   { pattern: 'biblio agro/couvert', category: 'cover-crops' },
   { pattern: 'biblio agro/formations', category: 'formations' },
   { pattern: 'biblio agro', category: 'soil-health' },
   { pattern: 'livres agronomie/compost', category: 'soil-amendments' },
   { pattern: 'livres agronomie', category: 'agronomie-livres' },
   { pattern: 'agriculture', category: 'agriculture' },
   { pattern: 'agroforesterie', category: 'agroforesterie' },
   { pattern: 'agronomy', category: 'agronomy' },
   { pattern: 'input', category: 'inbox' },
];

/**
 * Filename-based heuristic rules for root-level files.
 *
 * Each rule tests the lowercased filename against one or more keywords.
 */
const FILENAME_RULES: Array<{ keywords: string[]; category: string }> = [
   { keywords: ['sol vivant', 'sol,', 'soil', 'pédolog', 'pedol', 'pedogen'], category: 'soil-health' },
   { keywords: ['viti', 'vignoble', 'vigne', 'vin ', 'wine', 'vineyard', 'oenolog'], category: 'viticulture' },
   { keywords: ['regenerat', 'régénérat'], category: 'regenerative-agriculture' },
   { keywords: ['couvert', 'cover crop', 'cover_crop', 'intercrop'], category: 'cover-crops' },
   { keywords: ['agroforest', 'arbre'], category: 'agroforesterie' },
   { keywords: ['compost', 'matière organique', 'fertiliz', 'engrais'], category: 'soil-amendments' },
   { keywords: ['microb', 'mycorhiz', 'glomalin', 'microbiome'], category: 'soil-biology' },
   { keywords: ['fao', 'alimentation', 'food security'], category: 'food-systems' },
   { keywords: ['climat', 'climate'], category: 'climate' },
   { keywords: ['irrigation', 'water', 'hydri'], category: 'water-management' },
   { keywords: ['allelopath'], category: 'allelopathy' },
   { keywords: ['maraîch', 'potager', 'garden', 'jardin'], category: 'market-gardening' },
];

/**
 * Resolves the OKF category for a given file based on its path relative
 * to the scan root directory.
 *
 * @param absoluteFilePath  Absolute path to the file being ingested.
 * @param scanRoot          Absolute path to the root scan directory.
 * @returns The resolved OKF category slug.
 */
export function resolveCategory(absoluteFilePath: string, scanRoot: string): string {
   const relativePath = path.relative(scanRoot, absoluteFilePath);
   const relativeDir = path.dirname(relativePath).toLowerCase();
   const filename = path.basename(relativePath).toLowerCase();

   // 1. Try directory-based rules
   for (const rule of DIRECTORY_RULES) {
      if (relativeDir.startsWith(rule.pattern) || relativeDir.includes(rule.pattern)) {
         return rule.category;
      }
   }

   // 2. Try filename heuristics (for root-level files)
   for (const rule of FILENAME_RULES) {
      if (rule.keywords.some((kw) => filename.includes(kw))) {
         return rule.category;
      }
   }

   // 3. Fallback
   return 'inbox';
}

/**
 * Builds the S3 object key following the Option B convention:
 * `originals/<category>/<hash8>-<slug>.<ext>`
 *
 * @param category  OKF category slug.
 * @param hash      Full SHA-256 hash of the file.
 * @param filename  Original filename (will be slugified).
 * @returns The S3 object key string.
 */
export function buildS3Key(category: string, hash: string, filename: string): string {
   const ext = path.extname(filename).toLowerCase();
   const baseName = path.basename(filename, ext);
   const slug = slugifyFilename(baseName).slice(0, 80);
   const hash8 = hash.substring(0, 8);
   return `originals/${category}/${hash8}-${slug}${ext}`;
}

/**
 * Slugifies a filename for safe use in S3 keys.
 */
function slugifyFilename(text: string): string {
   return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/--+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '');
}
