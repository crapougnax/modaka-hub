# Modaka-Hub — How-To & Usage Guide

## Common Workflows

### 1. Ingesting a PDF Research Paper
1. In the **Ingestion & Curation** tab, drag and drop a PDF file into the dropzone.
2. Select the primary category (e.g., `soil-health`) and any transversal thematics (e.g., `cover-crops`, `water-management`).
3. Click **Ingest & Extract**.
4. The background queue extracts the text, generates AI metadata, stores the PDF in `assets/documents/`, and creates the OKF markdown file.

### 2. Manual Curation & Metadata Editing
1. Select a document from the central list.
2. Switch between **Visual Form** and **Raw YAML** to adjust tags, proper nouns, date, or author source.
3. Click **Save & Commit to Git**.

### 3. Creating a New Thematic Branch
1. Under **Thematics** in the left sidebar, click **+ New Category**.
2. Enter the slug and title (e.g. `agroforestry` / `Agroforestry Systems`).
3. The folder and index are automatically scaffolded in the target Git repository.
