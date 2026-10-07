#!/usr/bin/env bun
/**
 * Lightweight LLM Benchmark Script for Mac Apple Silicon (LM Studio)
 * 
 * Measures:
 * 1. Warmup ping
 * 2. Time To First Token (TTFT) and throughput (tokens/sec) via Streaming
 * 3. Structured JSON extraction fidelity on real botanical OCR text
 * 4. [Optional] Automated Qualitative Audit (LLM-as-a-Judge) with Gemini or Composite (ChatGPT + Claude)
 */

import dotenv from 'dotenv';
dotenv.config();

import {
  OkfEntryEvaluator,
  type OkfEvaluationReport,
  type CompositeEvaluationReport,
  type OkfDimensionScores,
} from '@quatrain/okf-ingest';

const args = process.argv.slice(2);
let evalMode: 'none' | 'gemini' | 'composite' | 'chatgpt' | 'claude' = 'none';
let targetModel = 'qwen2.5-7b-instruct-mlx';

for (const arg of args) {
  if (arg.startsWith('--eval')) {
    if (arg === '--eval' || arg === '--eval=gemini') {
      evalMode = 'gemini';
    } else if (arg === '--eval=composite') {
      evalMode = 'composite';
    } else if (arg === '--eval=chatgpt' || arg === '--eval=openai') {
      evalMode = 'chatgpt';
    } else if (arg === '--eval=claude' || arg === '--eval=anthropic') {
      evalMode = 'claude';
    }
  } else if (!arg.startsWith('--')) {
    targetModel = arg;
  }
}

const BASE_URL = process.env.LM_STUDIO_URL || 'http://localhost:1234/v1';
const MODEL = targetModel;

console.log(`\n======================================================`);
console.log(`⚡ Mac LLM Benchmark & Qualitative Audit`);
console.log(`  Endpoint    : ${BASE_URL}`);
console.log(`  Local Model : ${MODEL}`);
console.log(`  Audit Mode  : ${evalMode !== 'none' ? evalMode.toUpperCase() : 'Disabled (use --eval or --eval=composite)'}`);
console.log(`======================================================\n`);

// 1. Warmup Check
console.log(`[1/3] 🌡️  Warmup ping...`);
const t0 = performance.now();
let warmupData: any = {};
try {
  const warmupRes = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'Say "ready" in 1 word.' }],
      max_tokens: 10,
      temperature: 0.1
    })
  });
  warmupData = await warmupRes.json();
  const warmupTime = (performance.now() - t0).toFixed(0);
  console.log(`  ✓ Model warm in ${warmupTime}ms (response: "${warmupData.choices?.[0]?.message?.content?.trim()}")\n`);
} catch (err: any) {
  console.error(`  ❌ Failed to reach LM Studio at ${BASE_URL}:`, err.message);
  process.exit(1);
}

// 2. Generation Speed & TTFT Benchmark (Streaming)
console.log(`[2/3] 🏎️  Measuring TTFT & Generation Throughput (tokens/sec)...`);
const streamPrompt = "Write a concise 4-sentence overview of soil bio-indicators and agro-ecological diagnostic techniques.";

const streamStart = performance.now();
let ttft = 0;
let tokenCount = 0;
let firstChunk = true;

const streamRes = await fetch(`${BASE_URL}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: streamPrompt }],
    stream: true,
    max_tokens: 250,
    temperature: 0.2
  })
});

const reader = streamRes.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  if (firstChunk) {
    ttft = performance.now() - streamStart;
    firstChunk = false;
  }

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) continue;
    const payload = trimmed.slice(6);
    if (payload === '[DONE]') break;
    try {
      const parsed = JSON.parse(payload);
      const delta = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.delta?.reasoning_content;
      if (delta) tokenCount++;
    } catch {}
  }
}

const totalStreamTime = (performance.now() - streamStart) / 1000;
const genDuration = totalStreamTime - (ttft / 1000);
const tokensPerSec = genDuration > 0 ? (tokenCount / genDuration).toFixed(1) : 'N/A';

console.log(`  ⏱️  TTFT (Latency to first token) : ${ttft.toFixed(0)} ms`);
console.log(`  ⚡ Generation Throughput          : ${tokensPerSec} tokens/sec (${tokenCount} tokens in ${genDuration.toFixed(2)}s)`);
console.log(`  ⏳ Total Request Time            : ${totalStreamTime.toFixed(2)}s\n`);

// 3. Real Ingestion JSON Extraction Benchmark
console.log(`[3/3] 🔬 Structured JSON Extraction Test (Botanical fiche)...`);

const sampleOcr = `ACANTHACÉES Description Plante vivace de 30-80 cm, pubescente, à tige robuste et dressée. Les feuilles sont opposées, les inférieures pétiolées et très grandes ont 30-60 cm de long, elles sont molles, pennatifides, lobées-dentées. Les fleurs blanches à violacées, à nervures purpurines, sont très grandes. Biotope primaire Lisières et clairières forestières humides de la région méditerranéenne. Caractères indicateurs Engorgement en matière organique carbonée sur sol humide. Médecine Anti-inflammatoire.`;

const jsonStart = performance.now();
const jsonRes = await fetch(`${BASE_URL}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: `You are an expert botanical taxonomist. Extract structured information from the text. Return ONLY valid JSON with keys: title, scientificName, family, diagnosticKeys, soils, abstractFr. If the exact species title is not clearly legible or absent, set scientificName to "Undetermined".`
      },
      {
        role: 'user',
        content: sampleOcr
      }
    ],
    max_tokens: 4096,
    temperature: 0.1
  })
});

const jsonTotalTime = ((performance.now() - jsonStart) / 1000).toFixed(2);
const jsonData = await jsonRes.json();
const rawOutput = jsonData.choices?.[0]?.message?.content || '';

let parsedObj: Record<string, unknown> | null = null;
let cleanJson = rawOutput.trim();
if (cleanJson.startsWith('```json')) cleanJson = cleanJson.slice(7);
if (cleanJson.startsWith('```')) cleanJson = cleanJson.slice(3);
if (cleanJson.endsWith('```')) cleanJson = cleanJson.slice(0, -3);

try {
  parsedObj = JSON.parse(cleanJson.trim());
  console.log(`  ✓ Valid JSON extracted in ${jsonTotalTime}s !`);
  console.log(`  📊 Extracted Data:`);
  console.log(`     • Title           : ${parsedObj?.title || parsedObj?.name || 'N/A'}`);
  console.log(`     • Scientific Name : ${parsedObj?.scientificName || 'N/A'}`);
  console.log(`     • Family          : ${parsedObj?.family || 'N/A'}`);
  const soilsStr = Array.isArray(parsedObj?.soils) ? parsedObj.soils.join(', ') : (typeof parsedObj?.soils === 'string' ? parsedObj.soils : JSON.stringify(parsedObj?.soils || 'N/A'));
  const diagStr = Array.isArray(parsedObj?.diagnosticKeys) ? parsedObj.diagnosticKeys.slice(0, 2).join(' | ') : (typeof parsedObj?.diagnosticKeys === 'string' ? parsedObj.diagnosticKeys : JSON.stringify(parsedObj?.diagnosticKeys || 'N/A'));
  console.log(`     • Soil Indicators : ${soilsStr}`);
  console.log(`     • Diagnostic Keys : ${diagStr}`);
  if (parsedObj?.abstractFr) {
    console.log(`     • Abstract (FR)   : ${String(parsedObj.abstractFr).slice(0, 100)}...`);
  }
} catch (err: any) {
  console.log(`  ❌ JSON parse failed in ${jsonTotalTime}s:`, err.message);
  console.log(`  Raw output snippet: ${rawOutput.slice(0, 200)}...`);
}

// 4. Qualitative Audit (LLM-as-a-Judge)
if (evalMode !== 'none' && parsedObj) {
  console.log(`\n======================================================`);
  console.log(`🎯 Qualitative Evaluation (LLM-as-a-Judge)`);
  console.log(`======================================================`);

  const evaluator = new OkfEntryEvaluator();
  const target = {
    sourceText: sampleOcr,
    extracted: parsedObj,
    domainContext: 'Encyclopédie des plantes bio-indicatrices (Gérard Ducerf Vol 3). Contexte sol, bio-indication agronomique et nomenclature botanique stricte.',
    expectedFields: ['title', 'scientificName', 'family', 'soils', 'diagnosticKeys'],
  };

  const bar = (val: number, width = 10): string => {
    const filled = Math.max(0, Math.min(width, Math.round((val / 100) * width)));
    const empty = width - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${val.toFixed(0)}/100`;
  };

  const printReport = (r: OkfEvaluationReport) => {
    console.log(`\n  🏛️  Judge : ${r.judge.toUpperCase()} (${r.model})`);
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
        console.log(`        - Claimed in Doc : "${h.claimed}"`);
        console.log(`        - Source Reality : "${h.sourceReality}"`);
        console.log(`        - Reason         : ${h.explanation}`);
      }
    } else {
      console.log(`\n  ✓ Hallucinations : None detected! (100% faithful to source)`);
    }

    if (r.omissions.length > 0) {
      console.log(`\n  🔍 Omissions (${r.omissions.length}):`);
      for (const om of r.omissions) console.log(`     • ${om}`);
    }

    if (r.strengths.length > 0) {
      console.log(`\n  🏆 Strengths:`);
      for (const s of r.strengths) console.log(`     + ${s}`);
    }

    console.log(`\n  📝 Synthesis: "${r.summary}"`);
  };

  try {
    if (evalMode === 'composite') {
      console.log(`  Running multi-model consensus audit (Gemini + ChatGPT + Claude)...`);
      const composite = await evaluator.evaluateComposite(target);

      console.log(`\n  ======================================================`);
      console.log(`  🏆 COMPOSITE CONSENSUS SCORE`);
      console.log(`  ======================================================`);
      console.log(`  Overall Score   : ${composite.overallScore} / 100`);
      console.log(`  Overall Grade   : ${composite.overallGrade}`);
      console.log(`  Verdict         : ${composite.verdict}`);
      console.log(`  Inter-Judge Spread : ${composite.scoreVariance} pts (${composite.scoreVariance < 15 ? 'High Consensus' : 'Divergent Opinions'})`);
      console.log(`  Active Judges   : ${composite.activeJudges.join(', ')}`);

      console.log(`\n  ⚖️  Individual Judge Scorecard:`);
      console.log(`     --------------------------------------------------------`);
      console.log(`     | Judge    | Model                 | Score | Grade | Verdict |`);
      console.log(`     --------------------------------------------------------`);
      for (const j of composite.judges) {
        const jName = j.judge.padEnd(8);
        const mName = j.model.slice(0, 21).padEnd(21);
        const sVal = String(j.score).padStart(5);
        const gVal = j.grade.padEnd(5);
        const vVal = j.verdict.padEnd(7);
        console.log(`     | ${jName} | ${mName} | ${sVal} | ${gVal} | ${vVal} |`);
      }
      console.log(`     --------------------------------------------------------`);

      console.log(`\n  📊 Consensus Dimensional Averages:`);
      console.log(`     • Factual Fidelity        : ${bar(composite.dimensionAverages.factualFidelity)} (30%)`);
      console.log(`     • Taxonomic Accuracy      : ${bar(composite.dimensionAverages.taxonomicAccuracy)} (25%)`);
      console.log(`     • Bio-Indication Fidelity : ${bar(composite.dimensionAverages.bioIndicationCompleteness)} (20%)`);
      console.log(`     • Multilingual Quality    : ${bar(composite.dimensionAverages.multilingualQuality)} (15%)`);
      console.log(`     • Structure Compliance    : ${bar(composite.dimensionAverages.structureCompliance)} (10%)`);

      if (composite.consensusHallucinations.length > 0) {
        console.log(`\n  ⚠️  Consensus Hallucinations (${composite.consensusHallucinations.length}):`);
        for (const h of composite.consensusHallucinations) {
          const consensusBadge = h.consensus ? '🎯 [CONSENSUS AGREEMENT]' : '👀 [FLAGGED BY 1 JUDGE]';
          console.log(`     ${consensusBadge} Field: "${h.field}" (${h.severity})`);
          console.log(`        - Claimed : "${h.claimed}"`);
          console.log(`        - Reality : "${h.sourceReality}"`);
          console.log(`        - Details : ${h.explanation}`);
        }
      }

      console.log(`\n  📜 Executive Summary:\n  ${composite.summary}`);
    } else {
      console.log(`  Auditing with ${evalMode.toUpperCase()} judge...`);
      const singleReport = await evaluator.evaluate(target, { judge: evalMode });
      printReport(singleReport);
    }
  } catch (err: any) {
    console.error(`  ❌ Qualitative evaluation error:`, err.message);
  }
}

console.log(`\n======================================================`);
console.log(`🎉 Benchmark & Audit Complete!`);
console.log(`======================================================\n`);
