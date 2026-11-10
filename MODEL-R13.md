# R13 bilingual input anomaly detector

R13 is the local whole-input warning model selected for dsh-zh-typo-check 0.3.0 on 2026-11-10. It detects likely accidental input in Chinese, English and mixed text. It does not generate corrections. Existing character-level correction uses a separate optional model.

## Artifact and inference contract

- File: `semantic-r13-int8.onnx`, **27,092,583 bytes**.
- SHA-256: `da4505f9ff00fbdb26aa359b2089a32f4ae6efb56c6e03e275a489d5f1fe1cda`.
- Model and two vocabularies: **27,433,631 bytes**. Native runtime binaries are separate dependencies.
- Runtime: **onnxruntime-node 1.30.0**, CPU, 4 intra-op threads, 1 inter-op thread, batch 1.
- Both encoders read the entire input with their own BERT WordPiece tokenizer. At most 128 tokens each, including special tokens. Longer input is unavailable, never silently truncated.
- Inputs: six `int64 [1, sequence]` tensors: `z_input_ids`, `z_attention_mask`, `z_token_type_ids`, `e_input_ids`, `e_attention_mask`, `e_token_type_ids`.
- Output: noise logit minus logsumexp(normal, context), a margin, **not a probability**.
- Warn only when margin **strictly exceeds**: English `3.8071134090423584`; Chinese `5.315961837768555`; mixed `3.1870408058166504`.
- Language routing: a U+4E00–U+9FFF character plus an ASCII letter run of length ≥2 means mixed; a character in that range otherwise means Chinese; otherwise English. All routes still use both whole-input encoders.
- Vocab SHA-256: zh `45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c`; en `07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3`.

## Sources and modifications

Chinese encoder and unchanged vocabulary: [HFL Chinese ELECTRA 180G small discriminator](https://huggingface.co/hfl/chinese-electra-180g-small-discriminator/tree/826a243f3f387450ef8d70de9c3d0706d8d8e924), revision `826a243f3f387450ef8d70de9c3d0706d8d8e924` (HIT and iFLYTEK Research).

English encoder and unchanged vocabulary: [Google ELECTRA small discriminator](https://huggingface.co/google/electra-small-discriminator/tree/fa8239aadc095e9164941d05878b98afe9b953c3), revision `fa8239aadc095e9164941d05878b98afe9b953c3`.

Both upstream model cards specify Apache-2.0. R13 modifies the encoders/classification head through task fine-tuning, exports a dual-encoder graph and quantizes it to INT8. R13 model/vocabulary distribution includes [Apache-2.0](LICENSE-APACHE-2.0) and [NOTICE](NOTICE); this does not relicense third-party training datasets.

The research progression used authored examples, actual IME outputs, public normal-language examples and synthetic perturbations, with normal/noise/context labels. Public sources include [OpenAssistant/oasst1](https://huggingface.co/datasets/OpenAssistant/oasst1), [ASCEND](https://huggingface.co/datasets/CAiRE/ASCEND) (CC-BY-SA-4.0), and repository-separated GitHub issue titles. Initial CoLA/CoLAC probes are research benchmarks, not evidence of real IME accuracy. Original datasets, physical entropy archives and raw user data are not included in the plugin or model release. Source-specific conditions remain with the original providers; research reports describe splits and provenance.

## Evidence and limits

On the final **known** 675-row comparison: R13 detected **89/104** anomalies (including **46/57** actual IME anomalies), warned on **4/301** normal examples and **14/270** context-dependent examples. These are assistant labels and previously examined regression sets, not independent human gold or a population accuracy estimate. Prospective R13 tests still exceeded the desired normal/context warning limits; the chosen tradeoff accepts residual false positives.

Product integration matched source tokenizers in 4,700 comparisons and reproduced all 675 native reference margins and decisions exactly. Python ORT 1.23.2 scores differed on this quantized graph; do not substitute its margins while retaining these thresholds.

The original mixed nonsense is detected, while the tested normal gRPC/keepalive sentence and English question are not warned. Those examples do not guarantee behavior for all names, dialects, fragments, identifiers or unseen inputs. A warning asks the user to review; no warning does not establish correctness. Model absence, corruption, excessive length and inference errors are distinct unavailable states.

See `REPORT-SEMANTIC-ROUND13.md`, `REPORT-SEMANTIC-QWEN35.md` and `REPORT-SEMANTIC-JEV.md` in the source repository for the selection evidence. Original research snapshots remain immutable; user approval and product release are recorded separately.
