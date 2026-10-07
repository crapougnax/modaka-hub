# Ticket #7: Open Science, SPDX License & Rights Indexing

- **ID:** TICKET-07
- **Status:** 🚀 Implemented & Specified
- **Priority:** High
- **Components:** `modaka-hub`, `@quatrain/okf-ingest`, `@quatrain/ux-curation`, `ContentItem`, Ingestion Queue
- **Authors:** Quatrain & Bradtech Engineering Teams

---

## 🎯 Context & Objective

Scientific research papers (MDPI, Elsevier, INRAE, HAL open archives, etc.) and technical extension guides ingested into Modaka-Hub and OKF knowledge bases frequently state intellectual property terms under open licenses (such as Creative Commons CC BY 4.0, CC BY-SA, CC0) or proprietary terms.

Previously, these legal statements were preserved in raw markdown bodies or lumped under a generic `copyright` string, lacking a dedicated, standardized, and indexable field.

This ticket introduces a first-class `license` property across the entire ingestion, data modeling, and curation pipeline:
1. **Standardized SPDX Identifiers**: Captures normalized identifiers (e.g. `CC-BY-4.0`, `CC-BY-SA-4.0`, `CC0-1.0`, `Open Access`, `Proprietary`, `All Rights Reserved`).
2. **First-Class Persistence**: Structured into OKF YAML frontmatter (`license:`).
3. **Automated AI Extraction**: Added to Gemini multimodal extraction prompt and structured schema in `@quatrain/okf-ingest` and Modaka-Hub queue.
4. **Curator Workbench Control**: Displayed and editable in the curation form UI (`@quatrain/ux-curation`).

---

## 🏗️ OKF v0.2 Metadata Schema

```yaml
---
id: soil-management-cover-crops-vineyards
type: scientific-article
title: Soil Management by Cover Crops in Vineyards for Climate Change Adaptation
soa: bradtech/world-agronomy
revision: rev-38ab8b6
# --- Intellectual Property & Open Science ---
license: CC-BY-4.0
copyright: "© 2019 by the authors. Licensee MDPI, Basel, Switzerland"
publisher: MDPI
publicationYear: "2019"
language: en
# --- Taxonomies & Citations ---
category: viticulture/cover-crops
tags: [soil-management, cover-crops, vineyards, climate-change]
---
```

---

## 📋 Implemented Scope

1. **Core Type Contracts (`@quatrain/okf-ingest`)**:
   - `OkfFrontmatterV2`: added `license?: string`.
   - `OKF_BASE_PROPERTIES`: added `license: { type: 'STRING' }` and `copyright: { type: 'STRING' }`.
   - Prompts (`documentPrompt.ts`, `outlinePrompt.ts`): enriched with explicit instructions to extract standard SPDX license identifiers.
   - Decomposition (`monograph.ts`): propagation of `license` to book outline schema and master document frontmatter.

2. **Backend & Models (`modaka-hub`)**:
   - `ContentItem.ts`: declared `license` property in `ContentItemProperties`.
   - `queue.ts`: added `license` to `IngestQueueTask`, multimodal extraction prompt note, and `ContentItem.factory(...)`.
   - `curate.ts`: persistence of `license` field upon manual curation.
   - `bulk-ingest.ts`: propagation of `license` from `aiResult.metadata` to `OkfFrontmatterV2`.

3. **Curation UI (`@quatrain/ux-curation`)**:
   - `OKFDocumentMetadata`: added `license?: string` and `copyright?: string`.
   - `OKFMetadataForm.tsx`: added dedicated input fields with SPDX guidance, state binding, and YAML preview rendering.
