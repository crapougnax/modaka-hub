#!/usr/bin/env bun
/**
 * Standalone OKF Entry Qualitative Evaluator (LLM-as-a-Judge)
 * 
 * Usage:
 *   bun scripts/evaluate-entry.ts --entry <file.md|file.json> --source <source.txt> [--judge <gemini|chatgpt|claude|composite>]
 *   bun scripts/evaluate-entry.ts content/acanthacees/acanthe-molle.md --source raw_ocr.txt
 */

import fs from 'node:fs';
import dotenv from 'dotenv';
dotenv.config();

import {
  OkfEntryEvaluator,
  type OkfEvaluationReport,
  type CompositeEvaluationReport,
} from '@quatrain/okf-ingest';

const args = process.argv.slice(2);
let entryPath = '';
let sourcePath = '';
let judgeMode: 'gemini' | 'composite' | 'chatgpt' | 'claude' = 'gemini';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--entry' && args[i + 1]) {
    entryPath = args[++i];
  } else if (arg === '--source' && args[i + 1]) {
    sourcePath = args[++i];
  } else if (arg.startsWith('--judge=')) {
    judgeMode = arg.slice(8) as any;
  } else if (arg === '--judge' && args[i + 1]) {
    judgeMode = args[++i] as any;
  } else if (arg === '--composite') {
    judgeMode = 'composite';
  } else if (!arg.startsWith('--') && !entryPath) {
    entryPath = arg;
  } else if (!arg.startsWith('--') && !sourcePath) {
    sourcePath = arg;
  }
}

if (!entryPath || !sourcePath) {
  console.log(`
Usage:
  bun scripts/evaluate-entry.ts --entry <entry.md|entry.json> --source <source.txt> [options]

Options:
  --judge <gemini|chatgpt|claude|composite>   Selected judge or multi-model composite (default: gemini)
  --composite                                 Shortcut for --judge composite
`);
  process.exit(1);
}

if (!fs.existsSync(entryPath)) {
  console.error(`❌ Entry file not found: ${entryPath}`);
  process.exit(1);
}
if (!fs.existsSync(sourcePath)) {
  console.error(`❌ Source ground-truth file not found: ${sourcePath}`);
  process.exit(1);
}

const entryContent = fs.readFileSync(entryPath, 'utf-8');
const sourceText = fs.readFileSync(sourcePath, 'utf-8');

console.log(`\n======================================================`);
console.log(`🔍 OKF Qualitative Auditor (LLM-as-a-Judge)`);
console.log(`  Entry Document : ${entryPath}`);
console.log(`  Ground Truth   : ${sourcePath}`);
console.log(`  Evaluation Mode: ${judgeMode.toUpperCase()}`);
console.log(`======================================================\n`);

const evaluator = new OkfEntryEvaluator();
const target = {
  sourceText,
  extracted: entryContent,
  domainContext: 'Encyclopédie agronomique et botanique (Gérard Ducerf). Nomenclature binomiale latine stricte, bio-indication des sols et intégrité OKF v0.2.',
};

const bar = (val: number, width = 10): string => {
  const filled = Math.max(0, Math.min(width, Math.round((val / 100) * width)));
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${val.toFixed(0)}/100`;
};

const printReport = (r: OkfEvaluationReport) => {
  console.log(`  🏛️  Judge : ${r.judge.toUpperCase()} (${r.model})`);
  console.log(`  🎯 Score : ${r.score} / 100  |  Grade: ${r.grade}  |  Verdict: ${r.verdict}`);
  console.log(`\n  📊 Dimensional Breakdown:`);
  console.log(`     • Factual Fidelity        : ${bar(r.dimensions.factualFidelity)} (30%)`);
  console.log(`     • Taxonomic Accuracy      : ${bar(r.dimensions.taxonomicAccuracy)} (25%)`);
  console.log(`     • Bio-Indication Fidelity : ${bar(r.dimensions.bioIndicationCompleteness)} (20%)`);
  console.log(`     • Multilingual Quality    : ${bar(r.dimensions.multilingualQuality)} (15%)`);
  console.log(`     • Structure Compliance    : ${bar(r.dimensions.structureCompliance)} (10%)`);

  if (r.hallucinations.length > 0) {
    console.log(`\n  ⚠️  Hallucinations Detected (${r.hallucinations.length}):`);
    for (const h of r.hallucinations) {
      const badge = h.severity === 'critical' ? '🚨 [CRITICAL]' : h.severity === 'major' ? '⚠️  [MAJOR]' : 'ℹ️  [MINOR]';
      console.log(`     ${badge} Field: "${h.field}"`);
      console.log(`        - Claimed : "${h.claimed}"`);
      console.log(`        - Reality : "${h.sourceReality}"`);
      console.log(`        - Reason  : ${h.explanation}`);
    }
  } else {
    console.log(`\n  ✓ Hallucinations : None detected! (100% faithful to ground truth)`);
  }

  if (r.omissions.length > 0) {
    console.log(`\n  🔍 Omissions (${r.omissions.length}):`);
    for (const om of r.omissions) console.log(`     • ${om}`);
  }

  if (r.strengths.length > 0) {
    console.log(`\n  🏆 Strengths:`);
    for (const s of r.strengths) console.log(`     + ${s}`);
  }

  console.log(`\n  📝 Synthesis: "${r.summary}"\n`);
};

if (judgeMode === 'composite') {
  console.log(`Auditing with multi-model consensus (Gemini + ChatGPT + Claude)...`);
  const composite = await evaluator.evaluateComposite(target);

  console.log(`\n======================================================`);
  console.log(`🏆 COMPOSITE CONSENSUS SCORECARD`);
  console.log(`======================================================`);
  console.log(`Overall Score      : ${composite.overallScore} / 100`);
  console.log(`Overall Grade      : ${composite.overallGrade}`);
  console.log(`Consensus Verdict  : ${composite.verdict}`);
  console.log(`Inter-Judge Spread : ${composite.scoreVariance} pts (${composite.scoreVariance < 15 ? 'High Consensus' : 'Divergent Opinions'})`);
  console.log(`Active Judges      : ${composite.activeJudges.join(', ')}`);

  console.log(`\n⚖️  Individual Judge Scorecard:`);
  console.log(`   --------------------------------------------------------`);
  console.log(`   | Judge    | Model                 | Score | Grade | Verdict |`);
  console.log(`   --------------------------------------------------------`);
  for (const j of composite.judges) {
    const jName = j.judge.padEnd(8);
    const mName = j.model.slice(0, 21).padEnd(21);
    const sVal = String(j.score).padStart(5);
    const gVal = j.grade.padEnd(5);
    const vVal = j.verdict.padEnd(7);
    console.log(`   | ${jName} | ${mName} | ${sVal} | ${gVal} | ${vVal} |`);
  }
  console.log(`   --------------------------------------------------------`);

  console.log(`\n📊 Consensus Dimensional Averages:`);
  console.log(`   • Factual Fidelity        : ${bar(composite.dimensionAverages.factualFidelity)} (30%)`);
  console.log(`   • Taxonomic Accuracy      : ${bar(composite.dimensionAverages.taxonomicAccuracy)} (25%)`);
  console.log(`   • Bio-Indication Fidelity : ${bar(composite.dimensionAverages.bioIndicationCompleteness)} (20%)`);
  console.log(`   • Multilingual Quality    : ${bar(composite.dimensionAverages.multilingualQuality)} (15%)`);
  console.log(`   • Structure Compliance    : ${bar(composite.dimensionAverages.structureCompliance)} (10%)`);

  if (composite.consensusHallucinations.length > 0) {
    console.log(`\n⚠️  Consensus Hallucinations (${composite.consensusHallucinations.length}):`);
    for (const h of composite.consensusHallucinations) {
      const consensusBadge = h.consensus ? '🎯 [CONSENSUS AGREEMENT]' : '👀 [FLAGGED BY 1 JUDGE]';
      console.log(`   ${consensusBadge} Field: "${h.field}" (${h.severity})`);
      console.log(`      - Claimed : "${h.claimed}"`);
      console.log(`      - Reality : "${h.sourceReality}"`);
      console.log(`      - Details : ${h.explanation}`);
    }
  }

  console.log(`\n📜 Executive Summary:\n${composite.summary}\n`);
} else {
  console.log(`Auditing with ${judgeMode.toUpperCase()} judge...`);
  const report = await evaluator.evaluate(target, { judge: judgeMode });
  printReport(report);
}
