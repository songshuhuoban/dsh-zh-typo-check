/**
 * Client half of the Chinese typo checker.
 *
 * Timing policy (measured, see src/bench.mjs):
 *   - check() costs ~8µs at 60 chars, ~100µs at 1000 chars, ~0.5ms at 3000.
 *     That is two orders of magnitude below a frame, so it runs synchronously
 *     on every draft change: the underline lands in the same paint as the text.
 *   - Measurement reads the editor DOM in that same layout effect, so no frame
 *     is lost between the text and its marks.
 *   - Debounce only exists as a guard for very long drafts (pasted documents),
 *     and scroll/resize are coalesced to one pass per animation frame.
 *
 * Authored as a template: `tools/build-client.mjs` splices the checker core
 * (src/core.mjs) in at the CORE marker so the browser bundle stays one file
 * with no runtime imports beyond React.
 */
window.__ModuleLoader__.load({
  // 必须与 package.json 的 name 完全一致：壳按包名找这个工厂，
  // 名字对不上就是 "entry did not activate"，整个 web boot 会报错。
  // 构建时由 tools/build-client.mjs 从 bundle/package.json 注入。
  id: "dsh-zh-typo-check",
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')

    // ---- checker core (generated from src/core.mjs) ----
    /**
     * 中文输入框校对的判定内核（原型 v0）。
     *
     * 设计要点：这一层是纯函数、零依赖、可单测的「文本 -> 问题列表」，
     * 不碰 DOM、不碰 React。UI 侧只负责把 Issue 的字符区间映射成下划线矩形。
     *
     * 管线顺序刻意如此：
     *   1. mask      —— 先把代码/链接/英文/路径/命令遮住，它们不是中文，不该被判定；
     *   2. 词表命中   —— 错别字多数是「整词错形」，命中即高置信；
     *   3. 规则      —— 标点、重复字、可疑空格，低风险高收益；
     *   4. 边界抑制   —— 左/右邻字命中 guard 时丢弃，避免「原因该是」这类误报。
     */

    /** 词条置信度语义：0.95+ 几乎不会有争议；0.8 左右需要看上下文；0.6 只作为提示。 */
    const LEXICON = [
      // —— 同音 / 近音选错字 ——
      ['因该', '应该', 0.97],
      ['以经', '已经', 0.97],
      ['在次', '再次', 0.95],
      ['在见', '再见', 0.95],
      ['按耐不住', '按捺不住', 0.96],
      ['按耐', '按捺', 0.9],
      ['迫不急待', '迫不及待', 0.97],
      ['一如继往', '一如既往', 0.97],
      ['再接再励', '再接再厉', 0.97],
      ['甘败下风', '甘拜下风', 0.97],
      ['谈笑风声', '谈笑风生', 0.96],
      ['不加思索', '不假思索', 0.93],
      ['穿流不息', '川流不息', 0.95],
      ['必竟', '毕竟', 0.96],
      ['既使', '即使', 0.95],
      ['既便', '即便', 0.95],
      ['部份', '部分', 0.9],
      ['帐户', '账户', 0.85],
      ['图象', '图像', 0.9],
      ['好象', '好像', 0.9],
      ['情不自尽', '情不自禁', 0.97],
      ['一如反掌', '易如反掌', 0.9],

      // —— 形近字 ——
      ['松驰', '松弛', 0.95],
      ['精萃', '精粹', 0.9],
      ['绝然不同', '截然不同', 0.94],
      ['直接了当', '直截了当', 0.95],
      ['默守成规', '墨守成规', 0.96],
      ['变本加利', '变本加厉', 0.96],
      ['一愁莫展', '一筹莫展', 0.96],
      ['卑躬曲膝', '卑躬屈膝', 0.96],
      ['病入膏盲', '病入膏肓', 0.96],
      ['不径而走', '不胫而走', 0.96],
      ['出奇不意', '出其不意', 0.93],
      ['唇枪舌箭', '唇枪舌剑', 0.95],
      ['大才小用', '大材小用', 0.93],
      ['惮精竭虑', '殚精竭虑', 0.95],
      ['得不尝失', '得不偿失', 0.96],
      ['鼎立相助', '鼎力相助', 0.95],
      ['独挡一面', '独当一面', 0.94],
      ['发人深醒', '发人深省', 0.94],
      ['飞扬拔扈', '飞扬跋扈', 0.96],
      ['分道扬镖', '分道扬镳', 0.96],
      ['甘之如怡', '甘之如饴', 0.96],
      ['各行其事', '各行其是', 0.9],
      ['攻城掠地', '攻城略地', 0.85],
      ['骨梗在喉', '骨鲠在喉', 0.95],
      ['鬼鬼崇崇', '鬼鬼祟祟', 0.96],
      ['含辛如苦', '含辛茹苦', 0.96],
      ['汗流夹背', '汗流浃背', 0.96],
      ['好高鹜远', '好高骛远', 0.96],
      ['合盘托出', '和盘托出', 0.9],
      ['轰堂大笑', '哄堂大笑', 0.95],
      ['换然一新', '焕然一新', 0.96],
      ['及及可危', '岌岌可危', 0.96],
      ['娇揉造作', '矫揉造作', 0.96],
      ['矫往过正', '矫枉过正', 0.96],
      ['竭泽而鱼', '竭泽而渔', 0.95],
      ['金榜提名', '金榜题名', 0.94],
      ['刻骨名心', '刻骨铭心', 0.95],
      ['烩炙人口', '脍炙人口', 0.96],
      ['滥芋充数', '滥竽充数', 0.96],
      ['老奸巨滑', '老奸巨猾', 0.95],
      ['礼上往来', '礼尚往来', 0.95],
      ['厉厉在目', '历历在目', 0.95],
      ['美仑美奂', '美轮美奂', 0.95],
      ['迷天大谎', '弥天大谎', 0.95],
      ['名列前矛', '名列前茅', 0.96],
      ['明火执杖', '明火执仗', 0.95],
      ['脑羞成怒', '恼羞成怒', 0.95],
      ['旁证博引', '旁征博引', 0.95],
      ['披星带月', '披星戴月', 0.95],
      ['破斧沉舟', '破釜沉舟', 0.95],
      ['前扑后继', '前仆后继', 0.95],
      ['轻歌慢舞', '轻歌曼舞', 0.93],
      ['磬竹难书', '罄竹难书', 0.96],
      ['趋之若骛', '趋之若鹜', 0.96],
      ['如火如茶', '如火如荼', 0.95],
      ['弱不经风', '弱不禁风', 0.94],
      ['稍纵既逝', '稍纵即逝', 0.95],
      ['舍身取义', '舍生取义', 0.85],
      ['申张正义', '伸张正义', 0.9],
      ['声名雀起', '声名鹊起', 0.95],
      ['势均力抵', '势均力敌', 0.95],
      ['受益非浅', '受益匪浅', 0.94],
      ['水乳交溶', '水乳交融', 0.95],
      ['死皮癞脸', '死皮赖脸', 0.95],
      ['天翻地复', '天翻地覆', 0.95],
      ['甜言密语', '甜言蜜语', 0.95],
      ['通霄达旦', '通宵达旦', 0.96],
      ['脱颍而出', '脱颖而出', 0.96],
      ['妄费心机', '枉费心机', 0.95],
      ['忘恩负意', '忘恩负义', 0.94],
      ['委屈求全', '委曲求全', 0.93],
      ['卧薪偿胆', '卧薪尝胆', 0.95],
      ['乌烟障气', '乌烟瘴气', 0.95],
      ['无精打彩', '无精打采', 0.95],
      ['无是生非', '无事生非', 0.93],
      ['暇不掩瑜', '瑕不掩瑜', 0.95],
      ['消声匿迹', '销声匿迹', 0.94],
      ['心无旁鹜', '心无旁骛', 0.96],
      ['形消骨立', '形销骨立', 0.94],
      ['宣宾夺主', '喧宾夺主', 0.96],
      ['一诺千斤', '一诺千金', 0.95],
      ['以身作责', '以身作则', 0.95],
      ['义不容词', '义不容辞', 0.95],
      ['义愤填鹰', '义愤填膺', 0.96],
      ['饮鸠止渴', '饮鸩止渴', 0.96],
      ['英雄倍出', '英雄辈出', 0.95],
      ['怨天由人', '怨天尤人', 0.94],
      ['责无旁代', '责无旁贷', 0.95],
      ['仗义直言', '仗义执言', 0.94],
      ['真知卓见', '真知灼见', 0.95],
      ['针贬时弊', '针砭时弊', 0.96],
      ['震憾', '震撼', 0.95],
      ['支离破粹', '支离破碎', 0.96],
      ['指手划脚', '指手画脚', 0.9],
      ['置若惘闻', '置若罔闻', 0.95],
      ['众口烁金', '众口铄金', 0.95],
      ['重蹈复辙', '重蹈覆辙', 0.96],
      ['专心至志', '专心致志', 0.95],
      ['追悔莫急', '追悔莫及', 0.95],
      ['坐阵指挥', '坐镇指挥', 0.93],

      // —— 第二批：形近/同音成词，错误写法本身不是词 ——
      ['针炙', '针灸', 0.96],
      ['幅射', '辐射', 0.96],
      ['全愈', '痊愈', 0.95],
      ['烦燥', '烦躁', 0.95],
      ['寒喧', '寒暄', 0.96],
      ['撕杀', '厮杀', 0.95],
      ['通谍', '通牒', 0.94],
      ['盅惑', '蛊惑', 0.96],
      ['茶毒', '荼毒', 0.95],
      ['围巢', '围剿', 0.93],
      ['陡俏', '陡峭', 0.94],
      ['按磨', '按摩', 0.94],
      ['蒸溜', '蒸馏', 0.95],
      ['糟塌', '糟蹋', 0.95],
      ['装祯', '装帧', 0.94],
      ['肆业', '肄业', 0.95],
      ['竞然', '竟然', 0.96],
      ['做为', '作为', 0.88],
      ['蜇伏', '蛰伏', 0.94],
      ['巢臼', '窠臼', 0.93],
      ['循私', '徇私', 0.94],
      ['绯恻', '悱恻', 0.94],
      ['纵恿', '怂恿', 0.94],

      // —— 第二批：成语固定搭配 ——
      ['按步就班', '按部就班', 0.96],
      ['别出新裁', '别出心裁', 0.96],
      ['插科打浑', '插科打诨', 0.95],
      ['嗔目结舌', '瞠目结舌', 0.96],
      ['出类拔粹', '出类拔萃', 0.96],
      ['措手不急', '措手不及', 0.96],
      ['耳熟能祥', '耳熟能详', 0.95],
      ['分庭抗理', '分庭抗礼', 0.95],
      ['风声鹤立', '风声鹤唳', 0.95],
      ['浮想连翩', '浮想联翩', 0.95],
      ['功亏一溃', '功亏一篑', 0.96],
      ['鬼斧神功', '鬼斧神工', 0.96],
      ['好整以瑕', '好整以暇', 0.94],
      ['和霭可亲', '和蔼可亲', 0.96],
      ['既往不究', '既往不咎', 0.95],
      ['嘎然而止', '戛然而止', 0.96],
      ['兼收并畜', '兼收并蓄', 0.95],
      ['娇生贯养', '娇生惯养', 0.95],
      ['揭杆而起', '揭竿而起', 0.95],
      ['金璧辉煌', '金碧辉煌', 0.95],
      ['竞竞业业', '兢兢业业', 0.95],
      ['炯然不同', '迥然不同', 0.94],
      ['老生长谈', '老生常谈', 0.95],
      ['良秀不齐', '良莠不齐', 0.95],
      ['廖廖无几', '寥寥无几', 0.95],
      ['鳞次节比', '鳞次栉比', 0.95],
      ['络绎不决', '络绎不绝', 0.94],
      ['慢不经心', '漫不经心', 0.95],
      ['毛骨耸然', '毛骨悚然', 0.96],
      ['明辩是非', '明辨是非', 0.95],
      ['目不瑕接', '目不暇接', 0.95],
      ['呕心呖血', '呕心沥血', 0.96],
      ['蓬壁生辉', '蓬荜生辉', 0.95],
      ['迫在眉捷', '迫在眉睫', 0.95],
      ['契而不舍', '锲而不舍', 0.96],
      ['如出一撤', '如出一辙', 0.95],
      ['拾人牙惠', '拾人牙慧', 0.94],
      ['首曲一指', '首屈一指', 0.95],
      ['素味平生', '素昧平生', 0.95],
      ['贪脏枉法', '贪赃枉法', 0.95],
      ['提心掉胆', '提心吊胆', 0.96],
      ['挺而走险', '铤而走险', 0.95],
      ['同仇敌慨', '同仇敌忾', 0.95],
      ['推心至腹', '推心置腹', 0.95],
      ['望文生意', '望文生义', 0.94],
      ['无鸡之谈', '无稽之谈', 0.95],
      ['无瑕顾及', '无暇顾及', 0.94],
      ['笑逐眼开', '笑逐颜开', 0.95],
      ['诩诩如生', '栩栩如生', 0.95],
      ['循规导矩', '循规蹈矩', 0.95],
      ['沓无音信', '杳无音信', 0.96],
      ['应接不瑕', '应接不暇', 0.95],
      ['有条不素', '有条不紊', 0.95],
      ['与日具增', '与日俱增', 0.95],
      ['振聋发馈', '振聋发聩', 0.95],
      ['直言不诲', '直言不讳', 0.95],
      ['滋滋不倦', '孜孜不倦', 0.95],
      ['自惭形愧', '自惭形秽', 0.95],
      ['罪魁祸手', '罪魁祸首', 0.96],
      ['一股作气', '一鼓作气', 0.95],
    ]

    /**
     * 邻字抑制：命中词左右出现这些字时丢弃，
     * 因为它们会拼成一个合法词（"原因该是" 里的 "因该" 属于误切）。
     */
    const GUARDS = {
      因该: { left: '原病内外' },
      在次: { left: '存所' },
      既使: { left: '' },
      // 二字错形很容易只是更长合法词的一部分：包围|巢穴、大肆|业务、遵循|私人、安全|愈发。
      围巢: { left: '包' },
      肆业: { left: '大' },
      循私: { left: '遵' },
      全愈: { left: '保安' },
    }

    /**
     * 高频二字词，只用来做一件很窄的事：判两个字是不是被词边界隔开的。
     *
     * 没有它，`以经` 会在「可以经常」里被当成错字——`可以|经常` 明明切得好好的。
     * 规则是：错形的前一个字和首字能组成词（可+以=可以），或末字和后一个字能组成词
     * （便+宜=便宜），就说明这次命中跨了词边界，丢弃。
     *
     * 只对二字错形启用。四字成语本身自带边界，套这条规则反而会漏报。
     */
    const CROSSING_WORDS = new Set([
      // 左邻：以「因」结尾
      '原因', '病因', '内因', '外因', '起因', '成因', '诱因', '主因',
      // 以「以」结尾
      '可以', '所以', '予以', '加以', '借以', '用以', '足以', '难以', '得以', '给以', '赖以', '聊以',
      // 以「在」结尾
      '现在', '存在', '实在', '正在', '好在', '还在', '都在', '不在', '所在', '潜在', '内在', '外在',
      '志在', '何在', '自在', '尚在', '仍在', '已在', '常在', '永在',
      // 以「必」结尾
      '未必', '何必', '不必', '务必', '势必', '想必',
      // 以「部」结尾
      '全部', '内部', '外部', '局部', '干部', '本部', '大部',
      // 以「图」结尾
      '地图', '意图', '企图', '蓝图', '版图', '构图', '试图', '宏图', '绘图',
      // 以「好」结尾
      '很好', '最好', '更好', '正好', '还好', '刚好', '只好', '幸好', '爱好', '叫好', '讨好', '良好', '美好', '友好',
      // 以「情」结尾
      '事情', '感情', '心情', '爱情', '热情', '表情', '情形', '情况', '详情', '实情', '风情', '行情',
      // 以「松」结尾
      '轻松', '放松', '宽松', '蓬松',
      // 以「精」结尾
      '精神', '酒精', '精英', '精彩', '味精', '香精',
      // 以「针」结尾
      '打针', '方针', '针对', '顶针',
      // 以「幅」结尾
      '篇幅', '增幅', '幅度', '条幅', '巨幅',
      // 以「全」结尾
      '完全', '安全', '齐全', '周全', '成全', '保全', '顾全', '双全',
      // 以「烦」结尾
      '麻烦', '心烦', '厌烦', '耐烦',
      // 以「寒」结尾
      '寒冷', '严寒', '风寒', '心寒', '寒假', '御寒',
      // 以「通」结尾
      '交通', '沟通', '普通', '通过', '精通', '圆通', '打通', '畅通', '互通',
      // 以「茶」结尾
      '喝茶', '红茶', '绿茶', '奶茶', '花茶', '泡茶', '茶水',
      // 以「围」结尾
      '周围', '范围', '包围', '突围', '重围', '氛围', '外围', '合围',
      // 以「按」结尾
      '按照', '按时', '按钮', '按压', '按说',
      // 以「蒸」结尾
      '蒸发', '蒸笼', '蒸汽', '清蒸',
      // 以「糟」结尾
      '糟糕', '乱糟',
      // 以「装」结尾
      '服装', '安装', '包装', '装饰', '伪装', '装备', '组装', '套装', '假装',
      // 以「肆」结尾
      '放肆', '大肆', '肆意', '肆虐',
      // 以「竞」结尾
      '竞争', '竞赛', '竞技', '竞选', '竞相', '竞标',
      // 以「做」结尾
      '叫做', '当做', '看做', '算做',
      // 以「巢」结尾
      '鸟巢', '蜂巢', '老巢',
      // 以「循」结尾
      '遵循', '循环', '因循',
      // 以「纵」结尾
      '放纵', '操纵', '纵横', '纵然', '骄纵',

      // 右邻：以错形末字开头，和后面的字能成词
      '该当', '该死',
      '经常', '经过', '经验', '经济', '经典', '经营', '经历', '经手', '经由',
      '次日', '次数', '次要', '次序',
      '见面', '见到', '见解', '见识', '见证', '见闻',
      '竟然', '竟敢', '竟是',
      '使用', '使劲', '使命', '使馆', '使得',
      '便宜', '便利', '便于', '便是', '便捷',
      '份额', '份量',
      '户口', '户外', '户主',
      '象棋', '象征', '象牙',
      '像样', '像话', '像是',
      '驰骋', '驰名',
      '射击', '射线', '射门',
      '愈发', '愈合', '愈加',
      '燥热',
      '喧闹', '喧哗',
      '杀死', '杀害', '杀价',
      '毒性', '毒品', '毒害',
      '巢穴',
      '俏皮', '俏丽',
      '磨蹭', '磨损', '磨练', '磨合', '磨难',
      '溜达', '溜冰',
      '塌方', '塌陷',
      '业务', '业绩', '业余', '业主', '业已',
      '然后', '然而', '然则',
      '为了', '为难', '为首', '为何', '为人', '为止', '为例',
      '伏击', '伏特', '伏案',
      '私人', '私下', '私自', '私心',
    ])

    /**
     * 二字错形是否跨了词边界。`长度 > 2` 的条目不走这条，成语自带边界。
     * @param text 原文
     * @param start 错形起点
     * @param end 错形终点
     */
    function crossesWordBoundary(text, start, end) {
      if (start > 0 && CROSSING_WORDS.has(text.slice(start - 1, start + 1))) return true
      if (end < text.length && CROSSING_WORDS.has(text.slice(end - 1, end + 1))) return true
      return false
    }

    /** 单条词表构建成索引，避免每次线性扫描。按首字分组。 */
    const BY_FIRST = new Map()
    for (const [wrong, right, conf] of LEXICON) {
      if (!conf || wrong === right) continue
      const list = BY_FIRST.get(wrong[0]) ?? []
      list.push({ wrong, right, conf })
      BY_FIRST.set(wrong[0], list)
    }

    const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

    /** ASCII 标点及其全角对应。只在中文字境里报，避免误伤代码和数字。 */
    const PUNCT = {
      ',': '，',
      '.': '。',
      '?': '？',
      '!': '！',
      ':': '：',
      ';': '；',
    }

    /** 明确无歧义的叠字笔误。叠词（"看看""高高兴兴"）不在此列。 */
    const REPEAT_CHARS = new Set(['的', '地', '得', '了', '是', '在', '和', '与', '就', '也', '都'])

    /** 合法的叠用形式，不被「功能字重复」规则误伤。 */
    const VALID_DOUBLED = new Set(['的的确确', '地地道道'])

    /**
     * 叠字不是笔误的常见前缀。
     *
     * `现在在现场` 里的 `在在` 是 `现在|在`，`除了解决` 里的 `了了` 是 `除了|了`。
     * 只对「重复后仍成词」的那几个功能字生效——`但是是` 反而是真笔误，所以 `是`
     * 故意不在此列。这是那个判断器该做的事：不看词边界就分不清叠字和跨词。
     */
    const REPEAT_BLOCKERS = {
      在: '现存实正好还都不所潜内外志势何自尚未仍已便却又若而但常永长总竟尚',
      了: '除为罢算完好行对够',
    }

    /** 连续出现即为笔误的标点。省略号、破折号这类叠用是正常写法，不在此列。 */
    const REPEAT_PUNCT = new Set(['，', '。', '！', '？', '；', '：', '、'])

    /**
     * 句末的「的还」几乎总是「的话」。
     *
     * 这类错误任何词表都抓不到：`的还` 不是谁的错形，是「的话」被输入法选成了同音字，
     * 唯一的线索是它后面跟了个停顿。「他的还行」跟的是「行」，所以不会误报。
     */
    const DE_HAI_RE = /的还(?=[，。！？；：、”’）】》\s~～]|$)/g

    /**
     * 计算需要跳过的区间：代码、链接、命令、英文标识符、路径。
     * @param {string} text 原文
     * @returns {Uint8Array} 长度与 text 相同，1 表示该字符不参与中文判定
     */
    function buildMask (text) {
      const mask = new Uint8Array(text.length)
      const mark = (start, end) => {
        for (let i = Math.max(0, start); i < Math.min(text.length, end); i += 1) mask[i] = 1
      }

      // 围栏代码块、行内代码
      for (const re of [/```[\s\S]*?```/g, /`[^`\n]*`/g]) {
        re.lastIndex = 0
        let m
        while ((m = re.exec(text)) !== null) mark(m.index, m.index + m[0].length)
      }

      // 链接、邮箱、@引用、/命令、路径、版本号、纯英文词
      const atoms = [
        /https?:\/\/\S+/g,
        /www\.[^\s]+/g,
        /[\w.+-]+@[\w-]+\.[\w.-]+/g,
        /(^|\s)[/@][\w./-]+/g,
        /[A-Za-z]:\\[^\s，。；、）】]*/g,
        /[\w.-]*[/\\][\w./-]*/g,
        /v?\d+(?:\.\d+)+/g,
        /[A-Za-z][A-Za-z0-9_.-]*/g,
      ]
      for (const re of atoms) {
        re.lastIndex = 0
        let m
        while ((m = re.exec(text)) !== null) mark(m.index, m.index + m[0].length)
      }
      return mask
    }

    /**
     * 判定一段文本。
     * @param {string} text 输入框原文
     * @param {{ minConfidence?: number }} [options]
     * @returns {Array<{start:number,end:number,text:string,kind:string,message:string,suggestions:string[],confidence:number}>}
     */
    function check (text, options = {}) {
      const minConfidence = options.minConfidence ?? 0.8
      if (typeof text !== 'string' || text.length === 0) return []

      const mask = buildMask(text)
      const issues = []
      const taken = [] // 已占用的 [start,end)，后到的规则不能覆盖词表命中
      const overlaps = (s, e) => taken.some(([a, b]) => s < b && e > a)
      const push = (start, end, kind, message, suggestions, confidence) => {
        if (suggestions.length === 0) return
        if (suggestions[0] === text.slice(start, end)) return
        if (confidence < minConfidence) return
        if (overlaps(start, end)) return
        taken.push([start, end])
        issues.push({ start, end, text: text.slice(start, end), kind, message, suggestions, confidence })
      }

      // 1) 词表：逐字扫描，同一起点取最长命中
      for (let i = 0; i < text.length; i += 1) {
        if (mask[i]) continue
        const candidates = BY_FIRST.get(text[i])
        if (candidates === undefined) continue
        let best = null
        for (const entry of candidates) {
          if (text.startsWith(entry.wrong, i) === false) continue
          if (best === null || entry.wrong.length > best.wrong.length) best = entry
        }
        if (best === null) continue
        const guard = GUARDS[best.wrong]
        if (guard?.left && i > 0 && guard.left.includes(text[i - 1])) continue
        if (best.wrong.length <= 2 && crossesWordBoundary(text, i, i + best.wrong.length)) continue
        push(i, i + best.wrong.length, 'word', `疑似用词错误，应为「${best.right}」`, [best.right], best.conf)
        i += best.wrong.length - 1
      }

      // 1.5) 上下文规则：单个同音字，只有后面的停顿能定
      DE_HAI_RE.lastIndex = 0
      let deHai
      while ((deHai = DE_HAI_RE.exec(text)) !== null) {
        const at = deHai.index + 1
        if (mask[at]) continue
        push(at, at + 1, 'word', '句末的「的还」应为「的话」', ['话'], 0.92)
      }

      // 2) 中文语境里的半角标点
      for (let i = 0; i < text.length; i += 1) {
        if (mask[i]) continue
        const ch = text[i]
        if (PUNCT[ch] === undefined) continue
        // 前一个非空白字符是中文，才认为这是中文句读
        let j = i - 1
        while (j >= 0 && /\s/.test(text[j])) j -= 1
        if (j < 0 || !CJK.test(text[j])) continue
        const after = text[i + 1]
        if (after !== undefined && /\d/.test(after)) continue
        push(i, i + 1, 'punct', `中文语句应使用全角标点「${PUNCT[ch]}」`, [PUNCT[ch]], 0.95)
      }

      // 3) 功能字重复
      for (let i = 0; i + 1 < text.length; i += 1) {
        if (mask[i] || mask[i + 1]) continue
        if (text[i] !== text[i + 1]) continue
        if (!REPEAT_CHARS.has(text[i])) continue
        if (VALID_DOUBLED.has(text.slice(i, i + 4))) continue
        const blockers = REPEAT_BLOCKERS[text[i]]
        if (blockers !== undefined && i > 0 && blockers.includes(text[i - 1])) continue
        push(i, i + 2, 'repeat', `重复的「${text[i]}」`, [text[i]], 0.9)
      }

      // 4) 连续标点
      for (let i = 0; i + 1 < text.length; i += 1) {
        if (mask[i] || mask[i + 1]) continue
        if (text[i] !== text[i + 1]) continue
        if (!REPEAT_PUNCT.has(text[i])) continue
        push(i, i + 2, 'punct', `重复的标点「${text[i]}」`, [text[i]], 0.95)
      }

      return issues.sort((a, b) => a.start - b.start)
    }

    /** 把问题区间渲染成带 ^^^ 标注的文本，供命令行预览。 */
    function annotate (text, issues) {
      const lines = [text]
      let caret = ''
      let cursor = 0
      for (const issue of issues) {
        while (cursor < issue.start) {
          caret += ' '
          cursor += 1
        }
        caret += '^'.repeat(Math.max(1, issue.end - issue.start))
        cursor = issue.end
      }
      lines.push(caret)
      return lines.join('\n')
    }
    // ---- end checker core ----

    // ---- settings persistence bridge (generated from src/config-store.mjs) ----
    /**
     * 设置持久化桥：把「检查设置」接到宿主插件的 Config（DSH volatile 配置）上。
     *
     * 为什么不是 localStorage：DSH Desktop 每次启动都用 `--port 0` 起本地 Web 服务
     * （Electron 侧只拿到运行时端口），页面 origin 每次都变。localStorage 按 origin
     * 隔离，所以浏览器里存的设置在「重启 / 升级」后必然消失。宿主的 profile patch
     * 不随端口走，DSH 的设置服务会把插件 volatile 字段写进它——这才能跨启动、跨升级。
     *
     * 本文件是纯逻辑，不碰 DOM：测试用假的 scope / storage 直接跑（见 config-store.test.mjs）。
     *
     * 桥的职责：
     *   1. 把 Host 配置快照变成一份完整的设置（缺字段/坏值退回默认值）；
     *   2. 用户改动先立即生效（乐观更新），再写 Host；按字段记账，某个字段写失败
     *      只回滚该字段，不能因为别的字段写成功就把错误吞掉；
     *   3. Host 就绪前的本地改动、以及旧版本 localStorage 里的设置，用一次批量
     *      mutate 补写；失败保留待写值并限次重试，不覆盖旧缓存。
     */

    /** 与宿主 bundle/index.js 的 Config 字段一一对应；漏一个就会导致该设置不持久。 */
    const SETTINGS_FIELDS = [
      'enabled',
      'punctuation',
      'model',
      'fluency',
      'sensitivity',
      'source',
      'customBase',
    ]

    const DEFAULT_SETTINGS = Object.freeze({
      enabled: true,
      punctuation: true,
      model: true,
      // 实验功能：整句通顺度提示，默认关闭
      fluency: false,
      sensitivity: 'normal',
      source: 'auto',
      customBase: '',
    })

    const SENSITIVITY_LEVELS = ['low', 'normal', 'high']
    const SOURCE_LEVELS = ['auto', 'mirror', 'official', 'custom']
    /** 迁移/补写最多尝试几次；Host 顽固拒绝时别无限重写 profile。 */
    const MAX_PUSH_ATTEMPTS = 3

    /**
     * 读旧版 localStorage 时别信内容：任何字段类型不对都退回默认值。
     * 旧版 loadSettings 漏了 fluency，这里一并修掉。
     */
    function normalizeSettings(raw) {
      const next = { ...DEFAULT_SETTINGS }
      if (raw === null || typeof raw !== 'object') return next
      if (typeof raw.enabled === 'boolean') next.enabled = raw.enabled
      if (typeof raw.punctuation === 'boolean') next.punctuation = raw.punctuation
      if (typeof raw.model === 'boolean') next.model = raw.model
      if (typeof raw.fluency === 'boolean') next.fluency = raw.fluency
      if (SENSITIVITY_LEVELS.includes(raw.sensitivity)) next.sensitivity = raw.sensitivity
      if (SOURCE_LEVELS.includes(raw.source)) next.source = raw.source
      if (typeof raw.customBase === 'string') next.customBase = raw.customBase
      return next
    }

    /** JSON 文本 → 设置；解析失败返回 null（调用方决定退回什么）。 */
    function parseSettingsJson(text) {
      if (typeof text !== 'string' || text === '') return null
      try {
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
        return normalizeSettings(parsed)
      } catch (_error) {
        return null
      }
    }

    /** Host 快照里的 user 层是否为空：空表示用户从没在 Host 侧改过任何字段。 */
    function isEmptyUserLayer(user) {
      if (user === undefined || user === null) return true
      if (typeof user !== 'object' || Array.isArray(user)) return true
      return Object.keys(user).length === 0
    }

    /**
     * 输入框草稿什么时候**不该**被 Host 值覆盖。
     *
     * 两种情况必须保留用户输入（否则出现"填了地址、保存失败、内容被抹掉"）：
     *   1. 输入框正在聚焦；
     *   2. 该字段自己的写入失败、且草稿与已接受值不同 —— 用户的修改还没落盘。
     * 注意只认**这个字段**的失败：别的字段写成功不能解除这里的保护。
     *
     * @param {string} draft 输入框当前文本
     * @param {string} committed Host / 已接受的值
     * @param {{focused?: boolean, failed?: boolean}} [state]
     * @returns {boolean}
     */
    function shouldKeepDraft(draft, committed, state = {}) {
      if (state.focused === true) return true
      return state.failed === true && draft !== committed
    }

    /**
     * 单例设置桥。
     *
     * 不直接依赖 window：storage 由调用方传入，缺失时退化成「只在内存里」。
     */
    class ConfigSettings {
      /**
       * @param {{storage?: Storage|null, storageKey?: string, namespace?: string, onEvent?: (message: string) => void}} [options]
       */
      constructor(options = {}) {
        this.storage = options.storage ?? null
        this.storageKey = options.storageKey ?? 'dsh.zh-typo-check.settings'
        this.namespace = options.namespace ?? 'zh-typo-check'
        this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}

        /** localStorage 里是否真有旧版本的设置（决定要不要做一次性迁移）。 */
        this.hasCache = false
        /** 当前展示值（可能比 Host 已接受值超前：乐观更新）。 */
        this.value = this.readCache()
        /** Host 已接受的值；写失败时回滚到它。 */
        this.committed = { ...this.value }
        /** attach 那一刻的本地缓存，用于一次性迁移。 */
        this.cacheAtAttach = null
        /** configForms 里本插件的 form；null 表示宿主没提供（旧版 DSH）。 */
        this.scope = null
        this.ready = false
        this.syncing = false
        this.unsubscribe = null
        /** 单字段用户写入：字段 → 写序号（并发时只让最新一次失败触发回滚）。 */
        this.pending = new Map()
        this.sequence = 0
        /** 待批量补写的值（就绪前改动 / 迁移）；字段 → 期望值。 */
        this.pendingPush = new Map()
        this.pushInFlight = false
        this.pushAttempts = 0
        /** 迁移是否已处理过（只做一次；失败由 pendingPush 负责重试）。 */
        this.migrated = false
        /** 写失败字段：字段 → 最近一次错误文案。 */
        this.failedFields = new Map()
        this.namespaceUnavailable = false
        /** 对外错误状态：{ code, message, fields } 或 null。 */
        this.errorState = null
        this.listeners = new Set()
        this.errorListeners = new Set()
      }

      get() {
        return this.value
      }

      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      }

      /** @returns {{code: string, message: string, fields: string[]}|null} */
      getErrorState() {
        return this.errorState
      }

      /** 兼容旧调用：只取错误文案。 */
      getError() {
        return this.errorState === null ? null : this.errorState.message
      }

      /** 某个字段自己的最近一次写入是否失败（输入框草稿保护只认这个）。 */
      hasFieldError(field) {
        return this.failedFields.has(field)
      }

      subscribeError(listener) {
        this.errorListeners.add(listener)
        return () => this.errorListeners.delete(listener)
      }

      /**
       * 用户改设置：先本地生效，再逐字段写 Host。
       * Host 没接上时先排队（pendingPush），接上后一次批量补写。
       */
      set(patch) {
        if (patch === null || typeof patch !== 'object') return this.value
        const merged = { ...this.value }
        for (const field of SETTINGS_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(patch, field)) merged[field] = patch[field]
        }
        const next = normalizeSettings(merged)
        const changed = SETTINGS_FIELDS.filter((field) => next[field] !== this.value[field])
        if (changed.length === 0) return this.value

        this.value = next
        this.writeCache()
        this.notify()

        if (this.ready && this.scope !== null) {
          for (const field of changed) this.pendingPush.delete(field)
          this.persistFields(changed)
        } else {
          for (const field of changed) this.pendingPush.set(field, this.value[field])
        }
        return this.value
      }

      /**
       * 接上 configForms 的 form。
       * @returns 是否接上；没接上时设置只在本地生效（旧版 DSH 仍可用）。
       */
      attach(scope) {
        this.detach()
        if (scope === null || typeof scope !== 'object'
          || typeof scope.getSnapshot !== 'function' || typeof scope.subscribe !== 'function') {
          return false
        }
        this.scope = scope
        this.cacheAtAttach = { ...this.value }
        try {
          this.unsubscribe = scope.subscribe(() => this.syncFromScope())
        } catch (error) {
          this.unsubscribe = null
          this.scope = null
          this.ready = false
          this.reportError(['attach'], error)
          return false
        }
        this.onEvent('bridge attached')
        this.syncFromScope()
        if (!this.ready) this.onEvent('bridge attached, namespace not ready')
        return true
      }

      detach() {
        if (this.unsubscribe !== null) {
          try { this.unsubscribe() } catch (_error) { /* ignore */ }
          this.unsubscribe = null
        }
        // 在途写在重连后没法再跟踪回执，把期望值转进 pendingPush，重连后重新补写；
        // pendingPush 本身也不清，否则「就绪前改动 / 迁移」会在 provider 重载后丢。
        for (const field of this.pending.keys()) this.pendingPush.set(field, this.value[field])
        this.pending.clear()
        this.scope = null
        this.ready = false
      }

      dispose() {
        this.detach()
        this.pendingPush.clear()
        this.listeners.clear()
        this.errorListeners.clear()
      }

      /** Host 快照变化：采纳已接受的值，安排补偿写，处理命名空间不可用。 */
      syncFromScope() {
        if (this.scope === null) return
        if (this.syncing) return
        let snapshot
        try {
          snapshot = this.scope.getSnapshot()
        } catch (_error) {
          return
        }
        if (snapshot === null || typeof snapshot !== 'object') return
        // status: loading（Host 还没回）| ready | unavailable
        if (snapshot.status === 'unavailable') {
          // configForms 在、但本插件的配置命名空间不在（设置服务没起来 / Config 没有 volatile 字段）。
          // 不能假装"已接上"然后静默只写本地缓存——那正是本次要修的静默丢失。
          if (!this.namespaceUnavailable) {
            this.namespaceUnavailable = true
            this.onEvent('namespace unavailable: ' + this.namespace)
            this.recomputeError()
          }
          return
        }
        if (snapshot.status !== 'ready' || snapshot.value === null || typeof snapshot.value !== 'object') return

        // 快照监听可能在写 Host 的回执里同步触发；重入会把刚算出的补偿值覆盖掉，
        // 所以整段串行执行，内部触发的快照留到后续回调再处理。
        this.syncing = true
        try {
          const host = normalizeSettings(snapshot.value)
          this.committed = { ...host }
          if (this.namespaceUnavailable) {
            this.namespaceUnavailable = false
            this.failedFields.clear()
            this.recomputeError()
          } else if (this.failedFields.has('attach')) {
            // 连接期错误在真正就绪后就没有意义了（合成字段，不属于任何设置项）
            this.failedFields.delete('attach')
            this.recomputeError()
          }

          // 首次就绪且 Host 从没被改过：把旧版本 localStorage 里真实存在的设置排进补写。
          // migrated 只表示"看过旧缓存"，真正是否写成由 pendingPush 成功与否决定（可重试）。
          if (!this.migrated) {
            this.migrated = true
            if (this.hasCache && this.cacheAtAttach !== null && isEmptyUserLayer(snapshot.user)) {
              for (const field of SETTINGS_FIELDS) {
                if (this.cacheAtAttach[field] !== host[field] && !this.pendingPush.has(field)) {
                  this.pendingPush.set(field, this.cacheAtAttach[field])
                  this.value = { ...this.value, [field]: this.cacheAtAttach[field] }
                }
              }
            }
          }

          const next = { ...this.value }
          for (const field of SETTINGS_FIELDS) {
            // 在途单字段写 / 待批量补写 / 失败待重试的字段保留本地值，别被旧快照盖回去
            if (this.pending.has(field) || this.pendingPush.has(field) || this.failedFields.has(field)) continue
            next[field] = host[field]
          }
          const changed = SETTINGS_FIELDS.some((field) => next[field] !== this.value[field])
          this.ready = true
          this.value = next
          if (changed) {
            this.writeCache()
            this.notify()
          }
          if (this.pendingPush.size > 0) this.flushPendingPush()
          else if (changed === false && !this.pushInFlight) this.onEvent('ready, ' + SETTINGS_FIELDS.length + ' fields')
        } finally {
          this.syncing = false
        }
      }

      /**
       * 批量补写（迁移 / 就绪前改动）：能一次 mutate 就一次提交，避免"部分成功"。
       * 失败时保留期望值与错误，最多重试 MAX_PUSH_ATTEMPTS 次；旧缓存不被覆盖。
       */
      flushPendingPush() {
        if (this.pushInFlight || this.scope === null || this.pendingPush.size === 0) return
        if (this.pushAttempts >= MAX_PUSH_ATTEMPTS) {
          this.pendingPush.clear()
          this.recomputeError()
          this.onEvent('gave up flushing pending settings')
          return
        }
        const entries = [...this.pendingPush.entries()]
        const ops = entries.map(([field, value]) => ({ op: 'set', path: [field], value }))
        this.pushInFlight = true
        let result
        try {
          result = typeof this.scope.mutate === 'function'
            ? this.scope.mutate(ops)
            : Promise.all(entries.map(([field, value]) => this.scope.set(field, value))).then((accepted) => accepted.every(Boolean))
        } catch (error) {
          this.pushInFlight = false
          this.pushAttempts += 1
          this.reportError(entries.map(([field]) => field), error)
          return
        }
        Promise.resolve(result).then(
          (accepted) => {
            this.pushInFlight = false
            if (accepted === false) {
              this.pushAttempts += 1
              this.reportError(entries.map(([field]) => field), new Error('host rejected the pending settings'))
              return
            }
            for (const [field, value] of entries) {
              if (this.pendingPush.get(field) === value) this.pendingPush.delete(field)
              this.failedFields.delete(field)
            }
            this.pushAttempts = 0
            this.onEvent('flushed ' + entries.length + ' field(s)')
            this.recomputeError()
          },
          (error) => {
            this.pushInFlight = false
            this.pushAttempts += 1
            this.reportError(entries.map(([field]) => field), error)
          },
        )
      }

      /** 逐字段写 Host；configForms 自己会串行化并处理 revision 冲突。 */
      persistFields(fields) {
        if (this.scope === null) return
        for (const field of fields) {
          if (!SETTINGS_FIELDS.includes(field)) continue
          const token = ++this.sequence
          this.pending.set(field, token)
          let result
          try {
            result = this.scope.set(field, this.value[field])
          } catch (error) {
            this.failed(field, token, error)
            continue
          }
          Promise.resolve(result).then(
            (accepted) => {
              if (accepted === false) this.failed(field, token, new Error('host rejected the write'))
              else this.accepted(field, token)
            },
            (error) => this.failed(field, token, error),
          )
        }
      }

      accepted(field, token) {
        if (this.pending.get(field) !== token) return
        this.pending.delete(field)
        this.committed = { ...this.committed, [field]: this.value[field] }
        // 只清这个字段自己的失败，别让"另一个字段写成功"解除输入框草稿保护
        if (this.failedFields.delete(field)) this.recomputeError()
      }

      /** 写失败：只回滚该字段到 Host 已接受值，并保留它自己的错误状态。 */
      failed(field, token, error) {
        if (this.pending.get(field) !== token) return
        this.pending.delete(field)
        let recovered = null
        try {
          const snapshot = this.scope === null ? null : this.scope.getSnapshot()
          if (snapshot !== null && snapshot.status === 'ready' && snapshot.value !== null && typeof snapshot.value === 'object') {
            recovered = normalizeSettings(snapshot.value)
          }
        } catch (_error) { /* 用上一次提交值兜底 */ }
        const base = recovered ?? this.committed
        this.committed = { ...this.committed, [field]: base[field] }
        this.value = { ...this.value, [field]: base[field] }
        this.writeCache()
        this.notify()
        this.reportError([field], error)
      }

      /** 记录失败字段并重算对外错误；别的字段的失败互不覆盖。 */
      reportError(fields, error) {
        const message = error instanceof Error ? error.message : String(error)
        for (const field of fields) this.failedFields.set(field, message)
        this.onEvent('write failed: ' + message)
        this.recomputeError()
      }

      /** 对外错误状态：命名空间不可用优先；否则展示最近一个字段失败。 */
      recomputeError() {
        let next = null
        if (this.namespaceUnavailable) {
          next = { code: 'namespace-unavailable', message: 'settings namespace unavailable', fields: [] }
        } else if (this.failedFields.size > 0) {
          const fields = [...this.failedFields.keys()]
          const message = this.failedFields.get(fields[fields.length - 1])
          next = { code: 'write-failed', message, fields }
        }
        if (next === null ? this.errorState === null : (this.errorState !== null
          && this.errorState.code === next.code && this.errorState.message === next.message
          && JSON.stringify(this.errorState.fields) === JSON.stringify(next.fields))) return
        this.errorState = next
        for (const listener of this.errorListeners) listener(this.errorState)
      }

      notify() {
        for (const listener of this.listeners) listener(this.value)
      }

      readCache() {
        if (this.storage === null) return { ...DEFAULT_SETTINGS }
        try {
          const raw = this.storage.getItem(this.storageKey)
          const parsed = parseSettingsJson(raw)
          if (parsed !== null) this.hasCache = true
          return parsed ?? { ...DEFAULT_SETTINGS }
        } catch (_error) {
          return { ...DEFAULT_SETTINGS }
        }
      }

      writeCache() {
        if (this.storage === null) return
        try {
          this.storage.setItem(this.storageKey, JSON.stringify(this.value))
        } catch (_error) { /* 隐私模式：只保留内存值 */ }
      }
    }
    // ---- end settings persistence bridge ----

    /**
     * 诊断打点：把客户端发生的事写到宿主日志里。
     *
     * 放在工厂作用域，apply 和组件里都能用——之前在 apply 里定义成局部常量，
     * 组件里调用就抛 ReferenceError，而它恰好写在模型结果处理的 .then 里，
     * 异常被 .catch 吞掉，表现为"宿主答了、界面永远不画"。
     */
    function beacon(message) {
      try {
        void fetch('/zh-typo-model/log?msg=' + encodeURIComponent(String(message))).catch(() => {})
      } catch { /* 诊断不能影响功能 */ }
    }

    // 模块一被求值就打点：没有这条日志 = 客户端模块压根没加载
    beacon('factory evaluated, href=' + location.pathname)

    const NS = 'zh-typo-check'
    const MIN_CONFIDENCE = 0.9
    /** Above this many characters a synchronous pass stops being free; debounce it. */
    const LONG_TEXT_THRESHOLD = 4000
    const LONG_TEXT_DEBOUNCE_MS = 140
    const HIDE_DELAY_MS = 140
    const CACHE_LIMIT = 24

    /**
     * 模型检查的节流参数。
     *
     * 规则检查是微秒级，跟着每次按键同步跑；模型一次要 200–300 ms，
     * 只能等用户停手。400 ms 是"打完一句话"的体感分界点——
     * 再短会在输入过程中反复打断，再长用户会觉得没反应。
     */
    const MODEL_DEBOUNCE_MS = 400
    const MODEL_MIN_CHARS = 4
    const MODEL_MAX_CHARS = 500
    const STORAGE_KEY = 'dsh.zh-typo-check.ignored'
    const WARN_TOKEN = '--dsw-alias-state-warn-primary'

    /** 校验阶段的滑动条动画（React 内联样式没法写 @keyframes，用一段全局样式）。 */
    const ANIMATION_CSS = 
      '@keyframes zh-typo-indeterminate {'
      + ' 0% { margin-left: -30%; } 100% { margin-left: 100%; }'
      + '}'

    const STRINGS = {
      zh: {
        title: '中文检查',
        replace: '替换',
        ignore: '忽略',
    fluencyBody: '可能不通畅',
    optFluencyLabel: '整句通畅度（实验）',
    optFluencyHint: '没有具体错字、但整句读起来别扭时提醒一句。专业术语和人名可能误报。',

        sectionIntro: '在输入框里标出中文错别字和半角标点。本地规则永远可用；装上模型后，语义层面的误判也会被挡掉。',
        options: '检查设置',
        on: '开',
        off: '关',
        optEnabledLabel: '启用检查',
        optEnabledHint: '关掉之后输入框完全不受影响。',
        optPunctLabel: '检查半角标点',
        optPunctHint: '把 , ? ; 这类半角标点标出来。',
        optModelLabel: '使用模型',
        optModelHint: '需要先下载模型。关掉只跑规则，仍然立刻响应。',
        optSensitivityLabel: '模型灵敏度',
        optSensitivityHint: '激进会多报，保守会少报。',
        sensLow: '保守',
        sensNormal: '标准',
        sensHigh: '激进',
        optSourceLabel: '下载来源',
        optSourceHint: '自动会先探测哪条线路通，再决定顺序。',
        sourceAuto: '自动',
        sourceMirror: '国内镜像',
        sourceOfficial: '官方',
        sourceCustom: '自定义',
        customPlaceholder: 'https://你的镜像/…/macbert4csc-base-chinese/resolve/main',
        customInvalid: '地址需要以 http:// 或 https:// 开头',
        settingsSaveFailed: '设置没能保存：{error}',
        settingsNamespaceUnavailable: '这个 DSH 版本没有提供本插件的配置，设置只会留在当前页面。',
        model: '本地模型',
        stateAbsent: '未安装',
        stateDownloading: '下载中 {percent}%',
        stateVerifying: '校验中',
        statePartial: '下载未完成',
        resume: '继续下载',
        downloadingFile: '{file}（{index}/{count}）· {percent}%',
        partialDetail: '已下载 {size}，还差一部分',
        actionFailed: '操作失败：{error}',
        lastCheck: '上次模型检查：{state} · 命中 {issues} 处 · {ms} ms',
        lastCheckIdle: '上次模型检查：还没有跑过（在输入框里打一句话试试）',
        stateReady: '已就绪',
        stateError: '出错：{error}',
        stateChecking: '检查中…',
        stateUnavailable: '宿主服务不可用',
        cancel: '取消',
        remove: '删除',
        reDownload: '重新下载',
        download: '下载模型',
        noteReady: '模型只在本机运行，输入内容不会上传。删除后自动退回纯规则检查。',
        noteAbsent: '首次需要下载约 103 MB，支持国内镜像。未安装时只做规则检查，输入框照常可用。',
        runtimeMissing: '推理运行时缺失（onnxruntime-node 未安装），模型暂时无法加载。这只影响语义检查，规则检查照常工作。',
        hostUnavailable: '宿主服务不可用（{error}）。若刚更新过插件，重启 DSH 后生效。',
      },
      en: {
        title: 'Chinese check',
        replace: 'Replace',
        ignore: 'Ignore',
    fluencyBody: 'Reads awkwardly',
    optFluencyLabel: 'Sentence fluency (experimental)',
    optFluencyHint: 'A one-line note when the whole sentence reads oddly even though no single character is wrong. Jargon and names may trigger it.',

        sectionIntro: 'Flags Chinese typos and half-width punctuation in the composer. The rule engine always works; with the model installed, semantic mistakes are caught too.',
        options: 'Checking options',
        on: 'On',
        off: 'Off',
        optEnabledLabel: 'Enable checking',
        optEnabledHint: 'Turn off to leave the composer completely untouched.',
        optPunctLabel: 'Check half-width punctuation',
        optPunctHint: 'Flags ASCII , ? ; and friends.',
        optModelLabel: 'Use the model',
        optModelHint: 'Requires the model download. Without it, rules only, still instant.',
        optSensitivityLabel: 'Model sensitivity',
        optSensitivityHint: 'Aggressive flags more; conservative flags less.',
        sensLow: 'Conservative',
        sensNormal: 'Normal',
        sensHigh: 'Aggressive',
        optSourceLabel: 'Download source',
        optSourceHint: 'Auto probes which line works first, then decides the order.',
        sourceAuto: 'Auto',
        sourceMirror: 'China mirror',
        sourceOfficial: 'Official',
        sourceCustom: 'Custom',
        customPlaceholder: 'https://your-mirror/…/macbert4csc-base-chinese/resolve/main',
        customInvalid: 'The address must start with http:// or https://',
        settingsSaveFailed: 'Settings were not saved: {error}',
        settingsNamespaceUnavailable: 'This DSH version does not expose this plugin’s configuration, so settings only apply to this page.',
        model: 'Local model',
        stateAbsent: 'Not installed',
        stateDownloading: 'Downloading {percent}%',
        stateVerifying: 'Verifying',
        statePartial: 'Download incomplete',
        resume: 'Resume download',
        downloadingFile: '{file} ({index}/{count}) · {percent}%',
        partialDetail: '{size} downloaded, the rest is missing',
        actionFailed: 'Action failed: {error}',
        lastCheck: 'Last model check: {state} · {issues} hit(s) · {ms} ms',
        lastCheckIdle: 'Last model check: none yet (type a sentence in the composer)',
        stateReady: 'Ready',
        stateError: 'Failed: {error}',
        stateChecking: 'Checking…',
        stateUnavailable: 'Host service unavailable',
        cancel: 'Cancel',
        remove: 'Remove',
        reDownload: 'Download again',
        download: 'Download model',
        noteReady: 'The model runs on this machine only; nothing you type is uploaded. Removing it falls back to rule-only checking.',
        noteAbsent: 'The first download is about 103 MB and supports mirrors. Without it, only rule-based checking runs; the composer stays fully usable.',
        runtimeMissing: 'The inference runtime (onnxruntime-node) is missing, so the model cannot load. Rule-based checking is unaffected.',
        hostUnavailable: 'Host service unavailable ({error}). If the plugin was just updated, restart DSH.',
      },
    }

    /** `t()` 只做查表，带变量的句子在这里填空，避免把整句拆成碎片拼接。 */
    function format(template, values) {
      if (typeof template !== 'string') return ''
      return template.replace(/\{(\w+)\}/g, (whole, key) => (values[key] === undefined ? whole : String(values[key])))
    }

    // ---- 用户偏好 ----
    //
    // 设置存在宿主插件的 Config（DSH 会把它写进 profile 的 cordis.patch.yml），
    // 不再只存 localStorage：桌面版每次启动都会换一个本地端口，origin 一变
    // localStorage 就整份丢失——这正是「重启/升级后配置项被重置」的根因。
    // 旧版 DSH 没有 configForms 时，桥自动退化为只写本地缓存。
    const SETTINGS_KEY = 'dsh.zh-typo-check.settings'
    /** 与宿主 Config 共用的 Loader 条目 id：configForms 按它找配置命名空间。 */
    const CONFIG_NAMESPACE = 'zh-typo-check'

    /** 灵敏度档位 → 模型层的 Δ 阈值。阈值越低越容易报，也越容易误报。 */
    const SENSITIVITY = {
      low: 15,
      normal: 12,
      high: 9,
    }

    /** 隐私模式等场景下 localStorage 可能直接抛异常，这里兜住。 */
    function safeLocalStorage() {
      try {
        return window.localStorage
      } catch (_error) {
        return null
      }
    }

    const configSettings = new ConfigSettings({
      storage: safeLocalStorage(),
      storageKey: SETTINGS_KEY,
      namespace: CONFIG_NAMESPACE,
      onEvent: (message) => beacon('settings ' + message),
    })

    /**
     * 偏好存在模块级：输入框浮层和设置页是两个槽位里的组件，
     * 改一处要立刻影响另一处，靠这个小 store 打通。
     */
    const settingsStore = {
      get() { return configSettings.get() },
      set(patch) { return configSettings.set(patch) },
      subscribe(listener) { return configSettings.subscribe(listener) },
    }


    /**
     * 最近一次模型检查的结果，供设置页显示。
     *
     * 模型层是"静默增强"：没生效时界面上什么都不缺，所以用户没法判断
     * 到底是没有错、还是根本没查。这行诊断就是为了让这件事可观测。
     */
    const checkLogStore = {
      value: { state: 'idle', issues: 0, ms: 0, at: 0, detail: '' },
      listeners: new Set(),
      get() { return this.value },
      set(next) {
        this.value = next
        for (const listener of this.listeners) listener(next)
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    function useCheckLog() {
      const [value, setValue] = React.useState(checkLogStore.get())
      React.useEffect(() => checkLogStore.subscribe(setValue), [])
      return value
    }
    function useSettings() {
      return React.useSyncExternalStore(settingsStore.subscribe, settingsStore.get, settingsStore.get)
    }

    /** 设置错误的订阅/读取器（React 18 的 useSyncExternalStore 要求稳定引用）。 */
    const subscribeSettingsError = (listener) => configSettings.subscribeError(listener)
    const readSettingsError = () => configSettings.getErrorState()

    /** 设置写入失败的最近状态：{ code, message, fields }；null 表示没有错误。 */
    function useSettingsError() {
      return React.useSyncExternalStore(subscribeSettingsError, readSettingsError, readSettingsError)
    }

    /** Resolve the theme warning colour once, so the wave matches light and dark. */
    function resolveWaveColor() {
      try {
        const value = getComputedStyle(document.documentElement).getPropertyValue(WARN_TOKEN).trim()
        if (value !== '') return value
      } catch (_error) { /* fall through */ }
      return '#e8833a'
    }

    /** A 3px repeating wave, tinted with the theme warning colour. */
    function waveImage(color) {
      const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='8' height='3' viewBox='0 0 8 3'>"
        + "<path d='M0 2.1 Q2 0.5 4 2.1 T8 2.1' fill='none' stroke='" + color + "' stroke-width='1.3' stroke-linecap='round'/></svg>"
      return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")'
    }

    // ---- editor text helpers (generated from src/editor.mjs) ----
    /**
     * Editor text <-> draft offset mapping.
     *
     * The composer is a Lexical contenteditable, not a textarea, so the only
     * reliable source of glyph geometry is the DOM itself. These helpers walk the
     * editor's text nodes once and answer two questions:
     *
     *   - which draft offsets does the DOM currently represent (buildIndex), and
     *   - where on screen does a draft range sit (rangeRects).
     *
     * They deliberately stay free of React and of any Harness package so they can
     * be unit-tested against a hand-built node graph.
     */
    
    /**
     * Concatenate the editor's visible text in draft order and remember where every
     * text node starts. Chips (decorator nodes) are skipped: draft offsets around
     * them would not match their DOM, so the caller drops the whole measurement
     * when the two disagree.
     *
     * @param root the composer's contenteditable element
     * @returns {{ text: string, nodes: Array<{start:number,end:number,node:Text}> }}
     */
    function buildIndex(root) {
      const nodes = []
      let text = ''
      const walk = (element) => {
        for (const child of element.childNodes) {
          if (child.nodeType === 3) {
            nodes.push({ start: text.length, end: text.length + child.data.length, node: child })
            text += child.data
            continue
          }
          if (child.nodeType !== 1) continue
          if (child.tagName === 'BR') { text += '\n'; continue }
          if (child.hasAttribute('data-lexical-decorator')) continue
          walk(child)
        }
      }
      const blocks = root.children
      for (let i = 0; i < blocks.length; i += 1) {
        const block = blocks[i]
        if (block.hasAttribute('data-lexical-decorator')) continue
        if (text !== '' || i > 0) text += '\n'
        walk(block)
      }
      return { text, nodes }
    }
    
    /**
     * Viewport rectangles covering one draft range, split across text nodes.
     *
     * @param index result of buildIndex
     * @param start draft offset of the first character
     * @param end draft offset just past the last character
     * @returns viewport rectangles, in reading order
     */
    function rangeRects(index, start, end) {
      const rects = []
      for (const entry of index.nodes) {
        if (entry.end <= start) continue
        if (entry.start >= end) break
        const from = Math.max(start, entry.start) - entry.start
        const to = Math.min(end, entry.end) - entry.start
        if (to <= from) continue
        const range = document.createRange()
        range.setStart(entry.node, from)
        range.setEnd(entry.node, to)
        for (const rect of range.getClientRects()) {
          if (rect.width > 0.5 && rect.height > 0.5) {
            rects.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
          }
        }
      }
      return rects
    }
    // ---- end editor text helpers ----

    function loadIgnored() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        const parsed = raw === null ? [] : JSON.parse(raw)
        return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [])
      } catch (_error) {
        return new Set()
      }
    }

    function saveIgnored(words) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...words]))
      } catch (_error) { /* private mode: keep the in-memory set only */ }
    }

    const ignoreKey = (issue) => {
        if (issue.kind === 'punct') return 'punct:' + issue.start + ':' + issue.text
        if (issue.kind === 'model') return 'model:' + issue.context
        if (issue.kind === 'fluency') return 'fluency:' + issue.context
        return issue.text
      }

    /** Fallback input subscription: no session, nothing to select. */
    function useNoInput(selector) { return selector(undefined) }

    /** Fallback locale lookup: show the key itself. */
    function identityText(key) { return key }

    /**
     * Build one immutable view: the issues plus the rectangles they occupy.
     * Returns null whenever nothing can be shown safely (no editor, mid-IME,
     * chip present, or the DOM disagrees with the draft).
     */
    function computeView(draft, rev, found, ignored, wave, stamp, fluency) {
      if (typeof draft !== 'string' || draft === '') return null
      const root = document.querySelector('[data-composer-input]')
      if (root === null) return null
      // Never fight the IME: a composing draft is not yet what the user meant.
      if (root.hasAttribute('data-composer-composing') || root.closest('[data-composer-composing]') !== null) return null
      const issues = found.filter((issue) => !ignored.has(ignoreKey(issue)))
      // 没有任何具体错字时才提通顺度：两个提示叠在一起会互相抢注意力，
      // 而且错字是确定性的，优先给它。
      const sentenceLevel = issues.length === 0 && fluency !== null && fluency !== undefined
        && !ignored.has('fluency:' + draft)
      if (issues.length === 0 && !sentenceLevel) return null
      if (sentenceLevel) {
        issues.push({
          start: 0,
          end: Math.max(1, draft.length),
          kind: 'fluency',
          text: draft,
          // 忽略按整句记：这是"这句别提醒我"，不是"这个字别管"
          context: draft,
          message: 'fluencyBody',
          suggestions: [],
          sentence: true,
        })
      }
      const index = buildIndex(root)
      // A chip (file reference) makes the DOM text and the draft text diverge.
      // Trust the region before the first difference rather than going dark.
      let usable = draft.length
      if (index.text !== draft) {
        const shared = Math.min(index.text.length, draft.length)
        let at = 0
        while (at < shared && index.text.charCodeAt(at) === draft.charCodeAt(at)) at += 1
        usable = at
      }
      if (usable === 0) return null
      const marks = []
      if (sentenceLevel) {
        // 整句提示：按「视觉行」切段。每段同时带着整行的矩形——
        // 命中判定读的是 top/height，所以要覆盖整行文字，不能只留一条线，
        // 否则必须精准指到那条虚线才弹提示。
        const rows = new Map()
        for (const rect of rangeRects(index, 0, usable)) {
          const key = Math.round(rect.top)
          const seen = rows.get(key)
          if (seen === undefined) {
            rows.set(key, {
              left: rect.left,
              right: rect.left + rect.width,
              top: rect.top,
              bottom: rect.top + rect.height,
            })
          } else {
            seen.left = Math.min(seen.left, rect.left)
            seen.right = Math.max(seen.right, rect.left + rect.width)
            seen.top = Math.min(seen.top, rect.top)
            seen.bottom = Math.max(seen.bottom, rect.top + rect.height)
          }
        }
        for (const row of rows.values()) {
          if (row.right <= row.left) continue
          marks.push({
            left: row.left,
            top: row.top,
            width: row.right - row.left,
            height: row.bottom - row.top,
            // 虚线画在行底，命中区域是整行文字
            line: row.bottom,
            index: 0,
            sentence: true,
          })
        }
      } else {
        for (let i = 0; i < issues.length; i += 1) {
          if (issues[i].end > usable) continue
          for (const rect of rangeRects(index, issues[i].start, issues[i].end)) marks.push({ ...rect, index: i })
        }
      }
      if (marks.length === 0) return null
      return { text: draft, rev, issues, marks, wave, stamp }
    }

    /**
     * 把模型报的位置并进规则的结果里。
     *
     * 同一处两边都报了就以规则为准——规则的判据是确定性的，模型只是补盲区。
     */
    function mergeModelIssues(base, modelIssues, text) {
      if (!Array.isArray(modelIssues) || modelIssues.length === 0) return base
      const merged = base.slice()
      for (const hit of modelIssues) {
        const start = hit.index
        const end = start + 1
        if (!Number.isInteger(start) || start < 0) continue
        if (merged.some((other) => start < other.end && end > other.start)) continue
        merged.push({
          start,
          end,
          kind: 'model',
          text: hit.original,
          // 忽略时按上下文记，不按单字记：人名这类误报一忽略就是整句话的事，
          // 而按字记会把所有该字的位置一起放过。
          context: typeof text === 'string' ? text.slice(Math.max(0, start - 2), start + 3) : hit.original,
          message: '按上下文更像「' + hit.candidate + '」',
          suggestions: [hit.candidate],
          confidence: 0.85,
        })
      }
      merged.sort((a, b) => a.start - b.start)
      return merged
    }

    /**
     * 新算出来的视图值不值得替换旧的。
     *
     * 除文本和版本号外还必须比这两样：
     *   - `stamp`：忽略列表与模型结果的版本。忽略一条错误时文本没变，
     *     只比文本会把新结果丢掉，表现成"点了忽略没反应"。
     *   - `marks`：实际几何。滚动/换行会让下划线移位而文本不变。
     */
    function sameView(a, b) {
      if (a === null || b === null) return a === b
      return a.text === b.text
        && a.rev === b.rev
        && a.stamp === b.stamp
        && sameGeometry(a.marks, b.marks)
    }

    /** 两组标记是否落在同一位置——用来跳过无意义的重新渲染。 */
    function sameGeometry(a, b) {
      if (a.length !== b.length) return false
      for (let i = 0; i < a.length; i += 1) {
        if (a[i].left !== b[i].left || a[i].top !== b[i].top) return false
        if (a[i].width !== b[i].width || a[i].index !== b[i].index) return false
      }
      return true
    }

    function TypoLayer(props) {
      // A missing prop must never take the composer down with it: the owner
      // always supplies both, but a fallback keeps the failure local.
      const useInput = typeof props.useInput === 'function' ? props.useInput : useNoInput
      const inputActions = props.inputActions
      const t = typeof props.t === 'function' ? props.t : identityText

      const draft = useInput((state) => (state === undefined || state === null ? '' : state.draft))
      const draftRev = useInput((state) => (state === undefined || state === null ? 0 : state.draftRev))
      const prefs = useSettings()

      const [view, setView] = React.useState(null)
      const [active, setActive] = React.useState(null)
      const [ignoredRev, bumpIgnored] = React.useReducer((n) => n + 1, 0)
      const [modelVersion, setModelVersion] = React.useState(0)
      const ignoredRef = React.useRef(null)
      if (ignoredRef.current === null) ignoredRef.current = loadIgnored()
      const cacheRef = React.useRef(new Map())
      /** 模型最近一次的结果：{ text, issues }。text 不匹配就当没有，避免错位。 */
      const modelRef = React.useRef({ text: '', issues: [] })
      /** 已经发过请求的文本，防止停止输入后每帧都打一次。 */
      const requestedRef = React.useRef('')
      /** 在途的模型请求：同一时刻只留一个，新的开始就把旧的掐掉，别让宿主排队。 */
      const inflightRef = React.useRef(null)
      /** 模型结果的按文本缓存：来回修改同一段文字时不必重问，也不会丢结果。 */
      const modelCacheRef = React.useRef(new Map())
      const hideTimer = React.useRef(0)
      const waveRef = React.useRef('')
      if (waveRef.current === '') waveRef.current = waveImage(resolveWaveColor())

      const refresh = React.useCallback(() => {
        const text = typeof draft === 'string' ? draft : ''
        let next = null
        if (prefs.enabled && text.length <= LONG_TEXT_THRESHOLD) {
          // Cache the verdict per draft text, not per revision: backspacing and
          // retyping the same words then costs a DOM measure, not a re-check.
          // Geometry is never cached, because the same text can move on screen.
          let found = cacheRef.current.get(text)
          if (found === undefined) {
            found = check(text, { minConfidence: MIN_CONFIDENCE })
            cacheRef.current.set(text, found)
            if (cacheRef.current.size > CACHE_LIMIT) {
              cacheRef.current.delete(cacheRef.current.keys().next().value)
            }
          }
          if (!prefs.punctuation) found = found.filter((issue) => issue.kind !== 'punct')
          // 规则先出结果，模型的结果到了再补一次——两者都不阻塞输入。
          let fromModel = []
          let fromFluency = null
          if (prefs.model) {
            const record = modelRef.current.text === text ? modelRef.current : modelCacheRef.current.get(text)
            if (record !== undefined) {
              fromModel = record.issues
              fromFluency = prefs.fluency && record.fluency?.low === true ? record.fluency : null
            }
          }
          const merged = mergeModelIssues(found, fromModel, text)
          next = computeView(text, draftRev, merged, ignoredRef.current, waveRef.current, ignoredRev + ':' + modelVersion, fromFluency)
        }
        setView((previous) => (sameView(previous, next) ? previous : next))
        setActive(null)
        // 偏好参与渲染结果，必须进依赖：关掉标点检查后要立刻生效
      }, [draft, draftRev, ignoredRev, modelVersion, prefs.enabled, prefs.punctuation, prefs.model, prefs.fluency])

      /**
       * 模型检查：停手 400 ms 后问一次宿主。
       *
       * 只在文本变过才发请求；宿主没装模型时返回得很快、issues 为空，
       * 所以"没装模型"这件事在这里不需要特判，也不会拖慢输入。
       */
      React.useEffect(() => {
        if (typeof draft !== 'string') return undefined
        if (!prefs.enabled || !prefs.model) return undefined
        if (draft.length < MODEL_MIN_CHARS || draft.length > MODEL_MAX_CHARS) return undefined
        // 灵敏度变了要重新问一次，所以缓存的文本里带上阈值
        const requestKey = draft + '|' + prefs.sensitivity
        if (requestedRef.current === requestKey) return undefined
        if (modelCacheRef.current.has(draft)) { requestedRef.current = requestKey; return undefined }
        const timer = window.setTimeout(() => {
          const startedAt = Date.now()
          requestedRef.current = requestKey
          if (inflightRef.current !== null) {
            try { inflightRef.current.abort() } catch { /* ignore */ }
            inflightRef.current = null
          }
          const controller = new AbortController()
          inflightRef.current = controller
          const url = MODEL_ENDPOINT + 'check?text=' + encodeURIComponent(draft)
            + '&delta=' + SENSITIVITY[prefs.sensitivity]
          fetch(url, { cache: 'no-store', signal: controller.signal })
            .then((response) => (response.ok ? response.json() : null))
            .then((body) => {
              const elapsed = Date.now() - startedAt
              const state = body === null ? 'HTTP 错误' : body.state
              const issues = body !== null && Array.isArray(body.issues) ? body.issues.length : 0
              const detail = body === null
                ? ''
                : [body.reason, body.chars !== undefined ? body.chars + ' 字' : '', body.aligned === false ? '分词未对齐' : '']
                  .filter((part) => typeof part === 'string' && part !== '').join(' · ')
              checkLogStore.set({ state, issues, ms: elapsed, at: Date.now(), detail: body?.error ? body.error : detail })
              if (body === null || body.state !== 'ready' || !Array.isArray(body.issues)) {
                // 这一次没成，下次文本再变还有机会——但不能把这句永久钉死成"查过了"。
                // 早先这里不重置，模型晚装好之后同一句话再也不会被查。
                requestedRef.current = ''
                return
              }
              const record = { text: draft, issues: body.issues, fluency: body.fluency ?? null }
              modelRef.current = record
              modelCacheRef.current.set(draft, record)
              if (inflightRef.current === controller) inflightRef.current = null
              if (modelCacheRef.current.size > CACHE_LIMIT) {
                modelCacheRef.current.delete(modelCacheRef.current.keys().next().value)
              }
              setModelVersion((n) => n + 1)
            })
            .catch((failure) => {
              if (failure?.name === 'AbortError') return
              requestedRef.current = ''
              checkLogStore.set({
                state: 'HTTP 不可用',
                issues: 0,
                ms: Date.now() - startedAt,
                at: Date.now(),
                detail: failure instanceof Error ? failure.message : String(failure),
              })
            })
        }, MODEL_DEBOUNCE_MS)
        return () => {
          window.clearTimeout(timer)
          // 卸载 / 升级（HMR 会销毁组件）时别把请求留在网络上；
          // 下一次 effect 会按新文本重新发。
          if (inflightRef.current !== null) {
            try { inflightRef.current.abort() } catch { /* ignore */ }
            inflightRef.current = null
          }
        }
      }, [draft, prefs.enabled, prefs.model, prefs.sensitivity])

      // Short drafts: check and measure synchronously, in the very paint that
      // changed the text. This is the whole latency budget.
      React.useLayoutEffect(() => {
        if (typeof draft === 'string' && draft.length <= LONG_TEXT_THRESHOLD) refresh()
      }, [refresh, draft])

      // Long drafts (a pasted document): same pass, but after the typing burst.
      React.useEffect(() => {
        if (typeof draft !== 'string' || draft.length <= LONG_TEXT_THRESHOLD) return undefined
        const timer = window.setTimeout(refresh, LONG_TEXT_DEBOUNCE_MS)
        return () => window.clearTimeout(timer)
      }, [refresh, draft])

      // Scroll and resize only move the marks: coalesce to one pass per frame.
      React.useEffect(() => {
        let frame = 0
        const schedule = () => {
          if (frame !== 0) return
          frame = window.requestAnimationFrame(() => { frame = 0; refresh() })
        }
        const scroller = document.querySelector('[data-input-scroll]')
        window.addEventListener('resize', schedule)
        window.addEventListener('scroll', schedule, true)
        scroller?.addEventListener('scroll', schedule, { passive: true })
        // An IME commit may not change the draft text (the attribute was the
        // only difference), so re-measure when composition ends.
        document.addEventListener('compositionend', schedule, true)
        return () => {
          if (frame !== 0) window.cancelAnimationFrame(frame)
          window.removeEventListener('resize', schedule)
          window.removeEventListener('scroll', schedule, true)
          scroller?.removeEventListener('scroll', schedule)
          document.removeEventListener('compositionend', schedule, true)
        }
      }, [refresh])

      React.useEffect(() => () => window.clearTimeout(hideTimer.current), [])

      const showNow = React.useCallback((index, anchor) => {
        window.clearTimeout(hideTimer.current)
        setActive({ index, anchor })
      }, [])

      const hideSoon = React.useCallback(() => {
        window.clearTimeout(hideTimer.current)
        hideTimer.current = window.setTimeout(() => setActive(null), HIDE_DELAY_MS)
      }, [])

      /**
       * 悬停判定走 document 的 mousemove，而不是给标记加 pointerEvents。
       *
       * 波浪线只有 3px 高，指上去很难命中；但把热区放大到整个字，就会挡住点击——
       * 用户想在错字前面放光标时会点不动。所以热区只存在于这张表里，
       * 页面上不占任何可点击面积，点击照常落到编辑器。
       */
      const hitRef = React.useRef([])
      React.useEffect(() => {
        if (view === null) return undefined
        hitRef.current = view.marks
        let frame = 0
        let pointerX = 0
        let pointerY = 0

        /**
         * 指针是不是在气泡上——**直接量它的矩形，不记状态**。
         *
         * 之前用了一个 `overBubble` 布尔标记，在气泡的 mouseenter 置位、mouseleave 复位。
         * 但点「忽略」/「替换」是把气泡卸载掉的，浏览器不会补发 mouseleave，
         * 标记就永远停在 true，之后每个 mousemove 都在第一行返回——
         * 表现就是"点过一次按钮，整段文字再也不弹气泡"。
         * 量矩形没有状态可残留。
         */
        const overBubble = (x, y) => {
          const element = document.querySelector('[data-zh-typo-bubble]')
          if (element === null) return false
          const rect = element.getBoundingClientRect()
          return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
        }

        const measure = () => {
          frame = 0
          const x = pointerX
          const y = pointerY
          if (overBubble(x, y)) return
          let hit = -1
          for (let i = 0; i < hitRef.current.length; i += 1) {
            const mark = hitRef.current[i]
            // 上下各放宽 3px：字的上沿和下沿都不该要求精确
            if (x < mark.left - 2 || x > mark.left + mark.width + 2) continue
            if (y < mark.top - 3 || y > mark.top + mark.height + 3) continue
            hit = i
            break
          }
          if (hit === -1) hideSoon()
          else if (active === null || active.index !== hitRef.current[hit].index) {
            showNow(hitRef.current[hit].index, hitRef.current[hit])
          }
        }

        const onMove = (event) => {
          pointerX = event.clientX
          pointerY = event.clientY
          if (frame !== 0) return
          frame = window.requestAnimationFrame(measure)
        }
        const onLeave = () => hideSoon()

        document.addEventListener('mousemove', onMove, { passive: true })
        document.addEventListener('mouseleave', onLeave)
        return () => {
          if (frame !== 0) window.cancelAnimationFrame(frame)
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseleave', onLeave)
        }
      }, [view, active, showNow, hideSoon])

      const applyFix = React.useCallback((issue) => {
        if (view === null) return
        const span = { start: issue.start, end: issue.end, draftRev: view.rev }
        const accepted = inputActions !== undefined && inputActions.insertText(issue.suggestions[0], span)
        setActive(null)
        if (!accepted) refresh()
      }, [view, inputActions, refresh])

      const ignore = React.useCallback((issue) => {
        ignoredRef.current.add(ignoreKey(issue))
        if (issue.kind !== 'punct' && issue.kind !== 'fluency') saveIgnored(ignoredRef.current)
        setActive(null)
        bumpIgnored()
      }, [])

      if (view === null) return null

      const issueOf = (index) => view.issues[index]
      const activeIssue = active === null ? null : issueOf(active.index)

      const layer = React.createElement('div', {
        'data-zh-typo-layer': '',
        style: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 900 },
      }, [
        ...view.marks.map((mark, position) => React.createElement('div', {
          key: 'u' + position,
          'data-zh-typo-mark': '',
          style: {
            position: 'fixed',
            left: mark.left + 'px',
            top: ((mark.sentence === true ? mark.line : mark.top + mark.height) - 3) + 'px',
            width: mark.width + 'px',
            height: '3px',
            backgroundImage: mark.sentence === true ? 'none' : view.wave,
            borderBottom: mark.sentence === true ? '2px dashed rgba(37, 99, 235, 0.55)' : 'none',
            backgroundRepeat: 'repeat-x',
            backgroundPosition: 'left bottom',
            // 纯装饰：命中判定由 document 的 mousemove 做，这里不接收任何指针事件
            pointerEvents: 'none',
          },
        })),
        activeIssue === null ? null : activeIssue.sentence === true ? sentenceBubble(active, t, {
          onIgnore: () => ignore(activeIssue),
          onEnter: () => window.clearTimeout(hideTimer.current),
          onLeave: hideSoon,
        }) : bubble(active, activeIssue, t, {
          onApply: () => applyFix(activeIssue),
          onIgnore: () => ignore(activeIssue),
          // 指针进气泡时先别关；真要不要关由 measure 量矩形决定
          onEnter: () => window.clearTimeout(hideTimer.current),
          onLeave: hideSoon,
        }),
      ])

      return ReactDOM.createPortal(layer, document.body)
    }

    /** The suggestion bubble, placed above the marked text unless it would clip. */
    function bubble(active, issue, t, handlers) {
      const anchor = active.anchor
      const width = 240
      const center = anchor.left + anchor.width / 2
      const left = Math.min(Math.max(8, center - width / 2), window.innerWidth - width - 8)
      const above = anchor.top > 96
      const top = above ? anchor.top - 10 : anchor.top + anchor.height + 10

      return React.createElement('div', {
        key: 'bubble',
        'data-zh-typo-bubble': '',
        style: {
          position: 'fixed',
          left: left + 'px',
          top: top + 'px',
          transform: above ? 'translateY(-100%)' : 'none',
          width: width + 'px',
          boxSizing: 'border-box',
          pointerEvents: 'auto',
          // 白底 + 固定色值：气泡浮在正文之上，背景跟着主题变会让字色和底色打架，
          // 白底配深字在任何主题下都稳。
          background: '#ffffff',
          color: '#1f2329',
          border: '1px solid rgba(0,0,0,0.08)',
          borderRadius: '10px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          padding: '10px 12px',
          font: '13px/1.5 var(--dsw-font-family)',
        },
        onMouseEnter: handlers.onEnter,
        onMouseLeave: handlers.onLeave,
      }, [
        React.createElement('div', {
          key: 'body',
          style: { marginBottom: '8px', display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' },
        }, [
          React.createElement('span', {
            key: 'wrong',
            style: {
              color: '#d93026',
              textDecoration: 'line-through',
              textDecorationThickness: '1px',
            },
          }, issue.text),
          React.createElement('span', { key: 'arrow', style: { color: '#8f959e' } }, '→'),
          React.createElement('span', {
            key: 'right',
            style: { color: '#1a7f37', fontWeight: 600 },
          }, issue.suggestions[0]),
        ]),
        React.createElement('div', {
          key: 'actions',
          style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
        }, [
          React.createElement('button', {
            key: 'ignore',
            type: 'button',
            onMouseDown: (event) => event.preventDefault(),
            onClick: handlers.onIgnore,
            style: bubbleButtonStyle(false),
          }, t('ignore')),
          React.createElement('button', {
            key: 'apply',
            type: 'button',
            onMouseDown: (event) => event.preventDefault(),
            onClick: handlers.onApply,
            style: bubbleButtonStyle(true),
          }, t('replace')),
        ]),
      ])
    }

    /** 气泡里的按钮跟着白底走，不复用主题色，免得又出现底色和字色打架。 */
    /**
     * 整句提示的气泡：没有"换成什么字"，只有解释和忽略。
     * 与逐字气泡分开写，避免在同一个函数里堆两套完全不同的内容。
     */
    function sentenceBubble(active, t, handlers) {
      const anchor = active.anchor
      // 只有一句短话，宽度按内容给，别让气泡空一大片
      const width = 168
      const center = anchor.left + anchor.width / 2
      const left = Math.min(Math.max(8, center - width / 2), window.innerWidth - width - 8)
      const above = anchor.top > 96
      const top = above ? anchor.top - 10 : anchor.top + anchor.height + 10
      return React.createElement('div', {
        key: 'sentence-bubble',
        'data-zh-typo-bubble': '',
        style: {
          position: 'fixed',
          left: left + 'px',
          top: top + 'px',
          transform: above ? 'translateY(-100%)' : 'none',
          width: width + 'px',
          boxSizing: 'border-box',
          pointerEvents: 'auto',
          background: '#ffffff',
          color: '#1f2329',
          border: '1px solid rgba(0,0,0,0.08)',
          borderRadius: '10px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          padding: '10px 12px',
          font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
        },
        onMouseEnter: handlers.onEnter,
        onMouseLeave: handlers.onLeave,
      }, [
        React.createElement('div', {
          key: 'body',
          style: { marginBottom: '8px' },
        }, t('fluencyBody')),
        React.createElement('div', {
          key: 'actions',
          style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
        }, [
          React.createElement('button', {
            key: 'ignore',
            type: 'button',
            onMouseDown: (event) => event.preventDefault(),
            onClick: handlers.onIgnore,
            style: bubbleButtonStyle(false),
          }, t('ignore')),
        ]),
      ])
    }
    function bubbleButtonStyle(primary) {
      return {
        appearance: 'none',
        border: primary ? 'none' : '1px solid #d0d3d6',
        background: primary ? '#1f2329' : '#ffffff',
        color: primary ? '#ffffff' : '#1f2329',
        borderRadius: '7px',
        padding: '4px 14px',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }
    }

    function buttonStyle(primary) {
      return {
        appearance: 'none',
        border: primary ? 'none' : '1px solid var(--dsw-alias-border-l2)',
        background: primary ? 'var(--dsw-alias-brand-primary)' : 'transparent',
        color: primary ? '#fff' : 'var(--dsw-alias-label-secondary)',
        borderRadius: '7px',
        padding: '4px 12px',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }
    }

    const MODEL_ENDPOINT = '/zh-typo-model/'

    function formatBytes(bytes) {
      if (!bytes) return ''
      if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB'
      return (bytes / 1048576).toFixed(1) + ' MB'
    }

    /**
     * 设置页：模型的下载、校验与删除。
     *
     * 状态完全来自宿主侧的服务，页面本身不缓存任何东西——所以关掉设置页再打开、
     * 或者换一个浏览器，看到的都是同一份真相。
     */
    /** 设置页里的一行：左标题+说明，右侧控件。 */
    /** 自定义下载地址的合法性：只接受 http(s)，与服务端的判断保持一致。 */
    function isValidBase(value) {
      if (typeof value !== 'string' || value.trim() === '') return false
      try {
        const url = new URL(value.trim())
        return url.protocol === 'http:' || url.protocol === 'https:'
      } catch (_error) {
        return false
      }
    }

    function prefRow(key, label, hint, control) {
      return React.createElement('div', {
        key,
        style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 0' },
      }, [
        React.createElement('div', { key: 'text', style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } }, [
          React.createElement('span', {
            key: 'label',
            style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
          }, label),
          React.createElement('span', {
            key: 'hint',
            style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
          }, hint),
        ]),
        React.createElement('div', { key: 'spacer', style: { flex: 1 } }),
        control,
      ])
    }

    function toggleControl(t, checked, onToggle) {
      return React.createElement('button', {
        type: 'button',
        onClick: onToggle,
        style: {
          appearance: 'none',
          cursor: 'pointer',
          fontFamily: 'inherit',
          minWidth: '52px',
          padding: '4px 12px',
          borderRadius: '999px',
          fontSize: '12px',
          lineHeight: '18px',
          border: checked ? 'none' : '1px solid var(--dsw-alias-border-l2)',
          background: checked ? 'var(--dsw-alias-brand-primary)' : 'transparent',
          color: checked ? '#ffffff' : 'var(--dsw-alias-label-secondary)',
        },
      }, checked ? t('on') : t('off'))
    }

    function segmentStyle(active) {
      return {
        appearance: 'none',
        cursor: 'pointer',
        fontFamily: 'inherit',
        padding: '4px 10px',
        borderRadius: '7px',
        fontSize: '12px',
        lineHeight: '18px',
        border: active ? 'none' : '1px solid var(--dsw-alias-border-l2)',
        background: active ? 'var(--dsw-alias-brand-primary)' : 'transparent',
        color: active ? '#ffffff' : 'var(--dsw-alias-label-secondary)',
      }
    }

    /** 设置页与插件详情页共用的面板；head 控制要不要自己画标题。 */
    function ZhTypoPanel(props) {
      // 槽位没注入 t 时退回注册期绑定好的那个（同样是"调用时读当前语言"）
      const t = typeof props.t === 'function' ? props.t : boundT
      const prefs = useSettings()
      const settingsError = useSettingsError()
      const [status, setStatus] = React.useState(null)
      // 两种错误分开：轮询失败说明服务不可用，动作失败说明这一次点击没成功。
      // 混在一起会被下一次成功的轮询立刻抹掉，用户就只看到"点了没反应"。
      const [pollError, setPollError] = React.useState(null)
      const [actionError, setActionError] = React.useState(null)
      const [tick, setTick] = React.useState(0)
      const [busy, setBusy] = React.useState(false)
      const lastCheck = useCheckLog()
      /** 点过按钮之后的一段时间内继续轮询：宿主的下载可能还在探测线路，状态没翻过来。 */
      const settleRef = React.useRef(0)

      /**
       * 自定义下载地址是输入框：按「失焦提交」处理。
       * 每敲一个字就写一次 Host 既浪费又会让 profile 文件抖动，而且用户还在输入时
       * 写到一半的地址本来也没意义；失焦/回车才提交，提交失败保留输入并给出提示。
       */
      const [customBaseDraft, setCustomBaseDraft] = React.useState(prefs.customBase)
      const customBaseFocused = React.useRef(false)
      const customBaseDraftRef = React.useRef(customBaseDraft)
      customBaseDraftRef.current = customBaseDraft
      React.useEffect(() => {
        // 正在输入、或这个字段自己提交失败还没落盘时保留草稿
        // （别的字段写成功不能解除这里的保护，否则失败会把用户填的地址抹掉）
        const failed = settingsError !== null && settingsError.code === 'write-failed'
          && settingsError.fields.includes('customBase')
        if (shouldKeepDraft(customBaseDraftRef.current, prefs.customBase, {
          focused: customBaseFocused.current,
          failed,
        })) return
        setCustomBaseDraft(prefs.customBase)
      }, [prefs.customBase, settingsError])
      const commitCustomBase = React.useCallback(() => {
        const value = customBaseDraftRef.current.trim()
        if (value === configSettings.get().customBase) return
        settingsStore.set({ customBase: value })
      }, [])

      React.useEffect(() => {
        let alive = true
        let timer = 0
        const poll = async () => {
          try {
            const response = await fetch(MODEL_ENDPOINT + 'status', { cache: 'no-store' })
            if (!response.ok) throw new Error('HTTP ' + response.status)
            const next = await response.json()
            if (!alive) return
            setStatus(next)
            setPollError(null)
            // 校验也要继续轮询，否则界面会停在"校验中"；动作刚发生后的几秒也要盯住，
            // 因为宿主的下载可能还在探测线路，状态暂时还是 absent。
            const active = next.state === 'downloading' || next.state === 'verifying'
            if (active || Date.now() < settleRef.current) {
              timer = window.setTimeout(poll, 400)
            }
          } catch (failure) {
            if (alive) setPollError(failure instanceof Error ? failure.message : String(failure))
          }
        }
        poll()
        return () => { alive = false; window.clearTimeout(timer) }
      }, [tick])

      const act = React.useCallback(async (action) => {
        setBusy(true)
        setActionError(null)
        settleRef.current = Date.now() + 5000
        try {
          let url = MODEL_ENDPOINT + action
          if (action === 'download') {
            url += '?source=' + encodeURIComponent(prefs.source)
            if (prefs.source === 'custom') url += '&base=' + encodeURIComponent(customBaseDraftRef.current.trim())
          }
          const response = await fetch(url, { cache: 'no-store' })
          if (!response.ok) {
            // 宿主会把"地址无效"之类的具体原因放在 body 里；拿不到就报状态码，
            // 绝不能什么都不显示——那样用户只看到"点了一下没反应"。
            const body = await response.json().catch(() => null)
            setActionError(body !== null && typeof body.error === 'string'
              ? body.error
              : 'HTTP ' + response.status)
          }
        } catch (failure) {
          setActionError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
          setTick((n) => n + 1)
        }
      }, [prefs.source])

      const customValid = isValidBase(customBaseDraft)
      const canDownload = prefs.source !== 'custom' || customValid
      const error = actionError ?? pollError
      const state = status?.state ?? 'unknown'
      const progress = status !== null && status.total > 0 ? Math.min(1, status.bytes / status.total) : 0

      const statusText = {
        absent: t('stateAbsent'),
        downloading: format(t('stateDownloading'), { percent: Math.round(progress * 100) }),
        verifying: t('stateVerifying'),
        partial: t('statePartial'),
        ready: t('stateReady'),
        error: format(t('stateError'), { error: status?.error ?? '' }),
        unknown: error === null ? t('stateChecking') : t('stateUnavailable'),
      }[state] ?? state

      return React.createElement('div', {
        'data-zh-typo-settings': '',
        style: { display: 'flex', flexDirection: 'column', gap: '14px', padding: props.head === true ? '4px 2px' : '0', maxWidth: '620px' },
      }, [
        React.createElement('style', { key: 'anim' }, ANIMATION_CSS),
        props.head === true
          ? React.createElement('div', { key: 'head' }, [
            React.createElement('div', {
              key: 'title',
              style: { fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: '4px' },
            }, t('title')),
            React.createElement('div', {
              key: 'desc',
              style: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
            }, t('sectionIntro')),
          ])
          : null,

        React.createElement('div', {
          key: 'options',
          style: {
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '10px',
            padding: '6px 16px 10px',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        }, [
          React.createElement('div', {
            key: 'title',
            style: { fontSize: '12px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)', padding: '8px 0 2px' },
          }, t('options')),
          prefRow('enabled', t('optEnabledLabel'), t('optEnabledHint'), toggleControl(t, prefs.enabled, () => {
            settingsStore.set({ enabled: !prefs.enabled })
          })),
          prefRow('punct', t('optPunctLabel'), t('optPunctHint'), toggleControl(t, prefs.punctuation, () => {
            settingsStore.set({ punctuation: !prefs.punctuation })
          })),
          prefRow('model', t('optModelLabel'), t('optModelHint'), toggleControl(t, prefs.model, () => {
            settingsStore.set({ model: !prefs.model })
          })),
          prefRow('sens', t('optSensitivityLabel'), t('optSensitivityHint'),
            React.createElement('div', { key: 'seg', style: { display: 'flex', gap: '4px' } },
              ['low', 'normal', 'high'].map((level) => React.createElement('button', {
                key: level,
                type: 'button',
                onClick: () => settingsStore.set({ sensitivity: level }),
                style: segmentStyle(prefs.sensitivity === level),
              }, t(level === 'low' ? 'sensLow' : level === 'high' ? 'sensHigh' : 'sensNormal'))))),
          prefRow('fluency', t('optFluencyLabel'), t('optFluencyHint'), toggleControl(t, prefs.fluency, () => {
            settingsStore.set({ fluency: !prefs.fluency })
          })),          prefRow('source', t('optSourceLabel'), t('optSourceHint'),
            React.createElement('div', { key: 'seg', style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
              ['auto', 'mirror', 'official', 'custom'].map((level) => React.createElement('button', {
                key: level,
                type: 'button',
                onClick: () => settingsStore.set({ source: level }),
                style: segmentStyle(prefs.source === level),
              }, t(level === 'auto' ? 'sourceAuto'
                : level === 'mirror' ? 'sourceMirror'
                  : level === 'official' ? 'sourceOfficial' : 'sourceCustom'))))),
          prefs.source === 'custom'
            ? React.createElement('div', {
              key: 'custom-base',
              style: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '0 0 8px' },
            }, [
              React.createElement('input', {
                key: 'input',
                type: 'url',
                spellCheck: false,
                placeholder: t('customPlaceholder'),
                value: customBaseDraft,
                onChange: (event) => setCustomBaseDraft(event.target.value),
                onFocus: () => { customBaseFocused.current = true },
                onBlur: () => {
                  customBaseFocused.current = false
                  commitCustomBase()
                },
                onKeyDown: (event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  commitCustomBase()
                  event.currentTarget.blur()
                },
                style: {
                  width: '100%',
                  boxSizing: 'border-box',
                  fontFamily: 'inherit',
                  fontSize: '12px',
                  padding: '6px 10px',
                  borderRadius: '7px',
                  border: '1px solid ' + (customValid ? 'var(--dsw-alias-border-l2)' : 'var(--dsw-alias-state-error-primary)'),
                  background: 'var(--dsw-alias-bg-base)',
                  color: 'var(--dsw-alias-label-primary)',
                },
              }),
              customValid
                ? null
                : React.createElement('span', {
                  key: 'warn',
                  style: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
                }, t('customInvalid')),
            ])
            : null,
          settingsError !== null
            ? React.createElement('div', {
              key: 'settings-error',
              role: 'status',
              style: {
                fontSize: '12px',
                lineHeight: '18px',
                padding: '2px 0 8px',
                color: 'var(--dsw-alias-state-error-primary)',
              },
            }, settingsError.code === 'namespace-unavailable'
              ? t('settingsNamespaceUnavailable')
              : format(t('settingsSaveFailed'), { error: settingsError.message }))
            : null,
        ]),

        React.createElement('div', {
          key: 'model',
          style: {
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '10px',
            padding: '14px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        }, [
          React.createElement('div', {
            key: 'row',
            style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
          }, [
            React.createElement('span', {
              key: 'name',
              style: { fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
            }, t('model')),
            React.createElement('span', {
              key: 'state',
              style: {
                fontSize: '12px',
                color: state === 'ready'
                  ? 'var(--dsw-alias-state-success-primary)'
                  : state === 'error'
                    ? 'var(--dsw-alias-state-error-primary)'
                    : 'var(--dsw-alias-label-secondary)',
              },
            }, statusText),
            status !== null && state === 'ready'
              ? React.createElement('span', {
                key: 'size',
                style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
              }, formatBytes(status.bytes))
              : null,
            React.createElement('div', { key: 'spacer', style: { flex: 1 } }),
            state === 'downloading'
              ? React.createElement('button', {
                key: 'cancel',
                type: 'button',
                disabled: busy,
                onClick: () => act('cancel'),
                style: buttonStyle(false),
              }, t('cancel'))
              : null,
            state === 'ready'
              ? React.createElement('button', {
                key: 'delete',
                type: 'button',
                disabled: busy,
                onClick: () => act('delete'),
                style: buttonStyle(false),
              }, t('remove'))
              : null,
            state === 'absent' || state === 'error' || state === 'partial'
              ? React.createElement('button', {
                key: 'download',
                type: 'button',
                disabled: busy || !canDownload,
                onClick: () => act('download'),
                style: buttonStyle(true),
              }, state === 'partial' ? t('resume') : state === 'error' ? t('reDownload') : t('download'))
              : null,
          ]),
          state === 'downloading' || state === 'verifying'
            ? React.createElement('div', {
              key: 'bar',
              style: {
                height: '4px',
                borderRadius: '2px',
                background: 'var(--dsw-alias-border-l1)',
                overflow: 'hidden',
                position: 'relative',
              },
            }, React.createElement('div', {
              style: state === 'verifying'
                ? {
                  // 校验阶段没有字节进度，用一条滑动的条表示"在动"
                  width: '30%',
                  height: '100%',
                  background: 'var(--dsw-alias-brand-primary)',
                  animation: 'zh-typo-indeterminate 1.1s ease-in-out infinite',
                }
                : {
                  width: Math.round(progress * 100) + '%',
                  height: '100%',
                  background: 'var(--dsw-alias-brand-primary)',
                  transition: 'width .2s linear',
                },
            }))
            : null,
          state === 'downloading' && status !== null && typeof status.file === 'string' && status.file !== ''
            ? React.createElement('div', {
              key: 'file',
              style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
            }, format(t('downloadingFile'), {
              file: status.file,
              index: (status.fileIndex ?? 0) + 1,
              count: status.fileCount ?? 1,
              percent: Math.round(progress * 100),
            }))
            : null,
          state === 'partial' && status !== null
            ? React.createElement('div', {
              key: 'partial',
              style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
            }, format(t('partialDetail'), { size: formatBytes(status.bytes) }))
            : null,
          React.createElement('div', {
            key: 'last-check',
            style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
          }, lastCheck.at === 0
            ? t('lastCheckIdle')
            : format(t('lastCheck'), {
              state: lastCheck.detail === '' ? lastCheck.state : lastCheck.state + ' ' + lastCheck.detail,
              issues: lastCheck.issues,
              ms: lastCheck.ms,
            })),
          React.createElement('div', {
            key: 'note',
            style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
          }, state === 'ready' ? t('noteReady') : t('noteAbsent')),
          status !== null && status.runtime === false
            ? React.createElement('div', {
              key: 'runtime',
              style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-warn-primary)' },
            }, t('runtimeMissing'))
            : null,
          actionError !== null
            ? React.createElement('div', {
              key: 'action-error',
              style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
            }, format(t('actionFailed'), { error: actionError }))
            : null,
          pollError !== null
            ? React.createElement('div', {
              key: 'err',
              style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
            }, format(t('hostUnavailable'), { error: pollError }))
            : null,
        ]),
      ])
    }

    /**
     * 注册期要用的翻译函数：`bind` 返回稳定引用，但调用时才读当前语言，
     * 所以设置页的导航标题能跟着语言切换走。
     */
    let boundT = (key) => key

    function ZhTypoSection(props) {
      return React.createElement(ZhTypoPanel, { ...props, head: true })
    }

    /**
     * 详情页拿到的 subject 形状没有公开类型，所以按"整份 subject 里是否提到本插件"
     * 来判定；拿不准就渲染 null——槽位的契约就是"没内容就返回 null"。
     */
    function subjectMatchesPlugin(subject) {
      if (subject === null || typeof subject !== 'object') return false
      const direct = [
        subject.packageName, subject.name, subject.id, subject.entryId,
        subject.row?.name, subject.row?.entryId,
        subject.bundle?.packageName, subject.manifest?.name,
      ]
      if (direct.some((value) => typeof value === 'string' && value.includes('zh-typo-check'))) return true
      try {
        return JSON.stringify(subject).includes('zh-typo-check')
      } catch (_error) {
        return false
      }
    }

    /** 插件详情页里的「检查设置」区块：画自己的小标题，别重复页面已有的插件名。 */
    function ZhTypoDetailSection(props) {
      if (!subjectMatchesPlugin(props.subject)) return null
      return React.createElement('div', {
        'data-zh-typo-detail': '',
        style: { marginTop: '28px', display: 'flex', flexDirection: 'column', gap: '12px' },
      }, [
        React.createElement('div', {
          key: 'title',
          style: { fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
        }, boundT('options')),
        React.createElement(ZhTypoPanel, { ...props, head: false, key: 'panel' }),
      ])
    }

    /**
     * 把设置桥接到 Host 的插件配置（configForms）。
     *
     * 这是可选用途：旧版 DSH 没有 configForms 时，插件不能因此整个不加载——
     * 桥接不上就退回 localStorage，行为与旧版一致（只是仍会随 origin 丢失）。
     */
    function attachPersistedSettings(ctx, log) {
      try {
        ctx.inject(['configForms'], (scope) => {
          scope.effect(() => {
            let form = null
            try {
              form = scope.configForms.get(CONFIG_NAMESPACE)
            } catch (error) {
              log('settings bridge failed: ' + (error instanceof Error ? error.message : String(error)))
              return () => {}
            }
            const attached = configSettings.attach(form)
            log('settings bridge ' + (attached ? 'attached to ' + CONFIG_NAMESPACE : 'unavailable'))
            return () => {
              configSettings.detach()
              log('settings bridge detached')
            }
          }, 'zh-typo-check: persisted settings')
        })
      } catch (error) {
        log('settings bridge setup failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const beacon = (message) => {
          try { void fetch('/zh-typo-model/log?msg=' + encodeURIComponent(message)).catch(() => {}) } catch { /* ignore */ }
        }
        try {
          ctx.effect(() => ctx.locale.register(NS, STRINGS), 'zh-typo-check: dictionaries')
          boundT = ctx.locale.bind(NS)
          ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
            name: 'conversation.input.overlay',
            id: 'zh-typo-check',
            order: 10,
            locale: NS,
          }, TypoLayer))
          ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
            name: 'settings.plugins.tab',
            id: 'zh-typo-check',
            order: 20,
            label: () => boundT('title'),
          }, ZhTypoSection))
          ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
            name: 'plugins.detail.section',
            id: 'zh-typo-check',
            order: 30,
            label: () => boundT('options'),
          }, ZhTypoDetailSection))
          // 设置持久化：Host 的 plugin Config 在 profile patch 里，跨重启/升级保留
          attachPersistedSettings(ctx, beacon)
          beacon('apply done: 3 slots registered; settings bridge requested')
        } catch (error) {
          beacon('apply failed: ' + (error instanceof Error ? error.message : String(error)))
          throw error
        }
      },
    }
  },
})
