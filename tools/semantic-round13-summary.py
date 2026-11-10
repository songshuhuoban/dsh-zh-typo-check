"""Package the fixed research candidate and write complete comparisons."""
import importlib.util
from pathlib import Path
import shutil
import zipfile

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('r13',ROOT/'tools/semantic-round13.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
d=r.read(r.WORK/'results.json');s=d['selection']['selected'];current=d['configurations']['selected']['splits']
package=r.WORK/'package';assert not package.exists();package.mkdir()
shutil.copy2(r.WORK/s['artifact'],package/'model-int8.onnx');bases=r.read(r.WORK/'bases.json')
from transformers import AutoTokenizer
for lang in ['zh','en']:
    source=Path(bases[f'{lang}_folder']);dest=package/lang;dest.mkdir()
    for name in ['config.json','vocab.txt','tokenizer_config.json','special_tokens_map.json']:
        if (source/name).exists():shutil.copy2(source/name,dest/name)
    a=AutoTokenizer.from_pretrained(str(source),local_files_only=True,trust_remote_code=False)
    b=AutoTokenizer.from_pretrained(str(dest),local_files_only=True,trust_remote_code=False)
    for text in ['嗯','Hello world.','请检查这个 request。','女哦就是的感受a到啊删掉asd苏打粉二十个s收到']:
        assert a(text)==b(text),'Packaged tokenizer differs'
r.save(package/'bases.json',{'zh_folder':'zh','en_folder':'en'})
r.save(package/'selection.json',{'selected':{'artifact':'model-int8.onnx','artifact_sha256':s['artifact_sha256'],
    'thresholds':s['thresholds'],'mode':'dual'},'status':'research-only-not-approved','source_round':13})
r.save(package/'metadata.json',{'status':'research-only-not-approved','issue':'SIM-1048','budget_bytes':50_000_000,
    'source_artifact_sha256':s['artifact_sha256'],'model_plus_two_vocab_bytes':s['artifact_and_vocab_bytes'],
    'inputs':[prefix+name for prefix in ['z_','e_'] for name in ['input_ids','attention_mask','token_type_ids']],
    'input_type':'int64 [batch,sequence], separate zh/en tokenizers; each encodes the entire text',
    'max_tokens_per_encoder':128,'output':'scalar margin raw_noise-logsumexp(raw_normal,raw_context); not probability',
    'warning_rule':'margin > thresholds[language], strict >; language= mixed if CJK and ASCII alpha run length>=2, zh if CJK otherwise en',
    'caveat':'Assistant-only semantic labels; prospective false-positive and context gates failed; no default plugin replacement.',
    'base_models':{'zh':{'id':'hfl/chinese-electra-180g-small-discriminator','revision':'826a243f3f387450ef8d70de9c3d0706d8d8e924'},
        'en':{'id':'google/electra-small-discriminator','revision':'fa8239aadc095e9164941d05878b98afe9b953c3'}}})
(package/'README.txt').write_text('Research candidate R13, not approved for default plugin use.\n'
    'Model, both vocabularies, local tokenizer configs and fixed thresholds are included.\n'
    'Probe with the repository CPU environment: tools/semantic-predict.py --package <this directory> --text <text>\n'
    'Whole-input bilingual detection, max128 tokens per encoder. A margin is not a probability.\n'
    'See REPORT-SEMANTIC-ROUND13.md for new holdout and known-regression results.\n',encoding='utf-8')
assert r.sha(package/'model-int8.onnx')==s['artifact_sha256']
inventory={str(p.relative_to(package)).replace('\\','/'):r.sha(p) for p in package.rglob('*') if p.is_file()}
r.save(package/'files.sha256.json',inventory)
size=sum(p.stat().st_size for p in package.rglob('*') if p.is_file());assert size<=50_000_000
archive=r.WORK/'semantic-candidate-r13.zip';assert not archive.exists()
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for p in sorted(package.rglob('*')):
        if p.is_file():z.write(p,str(p.relative_to(package)))
d['delivery']={'folder':str(package.relative_to(ROOT)),'unpacked_bytes':size,'zip':str(archive.relative_to(ROOT)),
    'zip_bytes':archive.stat().st_size,'zip_sha256':r.sha(archive),'tokenizer_parity_verified':True,'status':'research-only-not-approved'}
r.save(r.WORK/'results.json',d);r.save(ROOT/'data/semantic-round13-results.json',d)
fmt=lambda p:'/'.join(map(str,p))
lines=['# 低误报硬约束选择与新留出复验：第十三轮','',
    '2026-11-10，SIM-1048。已知回归明显改善，新留出仍有误报及上下文提示；仅交付研究候选，未替换插件。','',
    '## 固定选择与数据边界','',
    'R12结果显示优先最低语言召回会选中正常提示较多的模型。本轮预先改为CAL正常误报<=0.5%硬约束，即1472条最多7次提示、上下文零提示、模型加词表<=50000000字节。',
    '再按最低语言召回、宏平均、较少误报、较少训练选择。候选固定R12五份INT8：baseline0、head1/3、last2 1/3，不重新训练、不按已知测试选择。',
    '规则改动受到R12已知回退启发，保留旧R12选择和结果；0.5%是CAL工程预算，不是总体误报保证。',
    'TRAIN/CAL与R12逐条不变，004仍是TRAIN。005及其公开200条此时已知，作为回归。',
    '按CAL选中文末两层epoch3：正常4/1472、上下文0/109，异常英文38/40、中文15/23、混排24/26；总77/89；R12原选择78/89。',
    f"模型加两份词表{s['artifact_and_vocab_bytes']:,}字节；含分词配置、阈值、来源和校验清单的完整推理包{size:,}字节，ZIP {archive.stat().st_size:,}字节。",'',
    '## 新独立样本（均在本轮封存后）','',
    '006实际50条：物理熵[136206,146228)，生成上界147456避免越入已用公开抽样区。逐字键入、一次Space，全提交、无排除，先初标正常2/异常26/上下文22，再评分。',
    '公开200短口语：物理熵[149952,152040)，中文100/英文40/混排60，旧TEST说话人且排除全部旧文本。先初标正常98/上下文102，再评分。',
    '键串和公开抽样从同一归档原始物理熵重放一致；无PRNG扩展。新增end-bit守卫在超界读取前拒绝，原001和005默认回放仍逐项相同。',
    '标签均为助手初标，允许口语、非母语表达、专名和拟声保留不确定性，并非独立人工金标。','',
    '| 方案 | 新IME异常 | 新IME正常提示 | 新IME上下文提示 | 新公开正常提示 | 新公开上下文提示 |',
    '|---|---:|---:|---:|---:|---:|']
for name in ['r9_strict','r9_pooled','r12_original','selected']:
    v=d['configurations'][name]['splits'];a=v['prospective_ime']['metrics'];b=v['prospective_public']['metrics']
    lines.append(f"| {name} | {fmt(a['noise_detected'])} | {fmt(a['normal_false_positives'])} | {fmt(a['context_warnings'])} | {fmt(b['normal_false_positives'])} | {fmt(b['context_warnings'])} |")
lines+=['',
    '新候选检出23/26（88.5%），R9合并22/26，严格11/26；相对R9合并多一条异常，也多一条上下文提示。',
    '新公开正常仍2/98（约2.04%），CAL误报预算不能保证实际误报率。真实上下文4/22（18.2%）超过预设5%。',
    '两条真实正常的0提示不能支持总体零误报。R12原选择在这批新留出上与本轮提示数相同，但分数并不相同。',
    '新异常召回、预算、既有回归检查通过；新公开正常与新真实上下文两项失败，全部门槛未过。','',
    '## 已知回归的完整比较','',
    '| 集合 | R9合并：正常/异常/上下文 | R12原选：正常/异常/上下文 | R13：正常/异常/上下文 |',
    '|---|---|---|---|']
for split,v in current.items():
    if split.startswith('prospective_'):continue
    def cell(name):
        m=d['configurations'][name]['splits'][split]['metrics']
        return '，'.join(fmt(m[k]) for k in ['normal_false_positives','noise_detected','context_warnings'])
    lines.append(f"| {split} | {cell('r9_pooled')} | {cell('r12_original')} | {cell('selected')} |")
lines+=['',
    '旧425：相对R9合并异常31/40→38/40、正常2/365保持2/365；旧公开正常误报6/506→3/506，英文word_soup28/28保持。',
    '相对R12原选，旧公开7/506→3/506、旧425异常33/40→38/40；但005回归异常24/31→23/31、上下文6/26→7/26，明确保留回退。',
    '因此候选改善的是若干已知集合的取舍，新样本尚未证明全面降低误报。','',
    '## 制品与核对','',
    f"模型SHA256 `{s['artifact_sha256']}`。固定阈值 `{s['thresholds']}`。",
    '源于R12已完成的真实CPU/DirectML编码器/分类头梯度核对与逐轮冻结参数断言；本轮没有重新训练。',
    f"该epoch3的FP32导出最大差{s['fp32_export_max_drift']:.8g}。Node原生旧425条batch1 p95 {current['known_round2']['p95_ms']:.3f}ms；不含分词、加载和UI。公开长文本组p95 {current['new_public_test']['p95_ms']:.3f}ms。",
    '推理包只包括单份INT8整句模型、两套词表和分词配置、固定阈值及元数据，没有训练权重或重复编码器文件；两套本地分词器与源分词器探针逐项相同。',
    '本地试句：研究CPU环境运行tools/semantic-predict.py --package .research/semantic-round13/package --text "整句话"；或--model round13。',
    '推理包为.research/semantic-round13/semantic-candidate-r13.zip；完整模型与元数据SHA清单在解压目录files.sha256.json。',
    '全部结果在data/semantic-round13-results.json；新原始输入输出和标签在data/ime-keyboard/*006*；公开候选与逐条理由在data/semantic-round13-public-*.json。',
    '本轮没有插件运行时/UI/驱动变更，没有staging部署和验收URL；研究推理包标记research-only-not-approved。','']
(ROOT/'REPORT-SEMANTIC-ROUND13.md').write_text('\n'.join(lines),encoding='utf-8')
with (ROOT/'NOTES.md').open('a',encoding='utf-8') as f:
    f.write('\n## 五十三、低误报硬约束校准与新独立复验（2026-11-10）\n\n'
        'SIM-1048：不重训，固定R12五候选，CAL正常提示<=7/1472(0.5%)及上下文0为硬约束，选末层epoch3。\n'
        '模型+词表27433631bytes，CAL正常4/1472、异常77/89；完整本地推理包低于50M，另含分词配置和固定阈值。\n'
        '新006实际50先标正常2/异常26/上下文22，候选异常23/26、正常0/2、上下文4/22；R9合并22/26、0/2、3/22。\n'
        '新公开200初标正常98/上下文102，候选正常2/98、上下文1/102；同R9合并。\n'
        '已知旧425异常31/40→38/40、正常2/365保持；旧公开正常6/506→3/506。005回归异常23/31、上下文7/26仍有退步。\n'
        '新实际上下文和公开正常门槛失败，不替换插件；原问题句命中，旧425Native p95约10.39ms。\n'
        '006物理熵[136206,146228)，新公开[149952,152040)，有界生成防复用并全部回放通过，累计370真实IME。\n'
        '详见REPORT-SEMANTIC-ROUND13.md与data/semantic-round13-results.json；predict支持round13和独立package目录。\n')
print({'package_unpacked_bytes':size,'zip_bytes':archive.stat().st_size,'report':'REPORT-SEMANTIC-ROUND13.md','all_gates_passed':d['all_gates_passed']})
