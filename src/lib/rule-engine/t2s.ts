// t2s1029（ENGINE_SYNTAX_JS_UTIL）：legado `java.t2s(text)` = io.legado.app.utils.ChineseUtils.t2s —— 首次调用先 fixT2sDict()
// 往 quick-transfer 的 TRADITIONAL_TO_SIMPLE 词典加排除词，再走 com.github.liuyueyi.quick.transfer.ChineseUtils.t2s
// （quick-transfer-core 0.2.17：DictionaryFactory.loadDictionary("tc/t2s.txt", false) + BasicDictionary.convert）。
// 全程按 UTF-16 单元（Java char）处理，代理对拆成两个单元原样查表，与 Java 同。

import { T2S_DICT_TEXT } from './t2s-dict';

interface TrieNode {
  readonly children: Map<number, TrieNode>;
  readonly level: number;
  leaf: boolean;
  value: string;
}

interface Dictionary {
  readonly charMap: Map<number, number>;
  readonly root: TrieNode;
  readonly maxLen: number;
}

/** legado ChineseUtils.fixT2sDict 的排除词（原样，含重复的「菲林」）。 */
const T2S_EXCLUDES: readonly string[] = [
  '槃',
  '划槳', '列根', '雪梨', '雪糕', '多士', '起司', '芝士', '沙芬', '母音',
  '华乐', '民乐', '晶元', '晶片', '映像', '明覆', '明瞭', '新力', '新喻',
  '零錢', '零钱', '離線', '碟片', '模組', '桌球', '案頭', '機車', '電漿',
  '鳳梨', '魔戒', '載入', '菲林', '整合', '變數', '解碼', '散钱', '插水',
  '房屋', '房价', '快取', '德士', '建立', '常式', '席丹', '布殊', '布希',
  '巴哈', '巨集', '夜学', '向量', '半形', '加彭', '列印', '函式', '全形',
  '光碟', '介面', '乳酪', '沈船', '永珍', '演化', '牛油', '相容', '磁碟',
  '菲林', '規則', '酵素', '雷根', '饭盒',
  '路易斯', '非同步', '出租车', '周杰倫', '马铃薯', '馬鈴薯', '機械人', '電單車',
  '電扶梯', '音效卡', '飆車族', '點陣圖', '個入球', '顆進球', '沃尓沃', '晶片集',
  '斯瓦巴', '斜角巷', '战列舰', '快速面', '希特拉', '太空梭', '吐瓦魯', '吉布堤',
  '吉布地', '史太林', '南冰洋', '区域网', '波札那', '解析度', '酷洛米', '金夏沙',
  '魔獸紀元', '高空彈跳', '铁达尼号', '太空战士', '埃及妖后', '吉里巴斯', '附加元件',
  '魔鬼終結者', '純文字檔案', '奇幻魔法Melody', '列支敦斯登',
];

const newNode = (level: number): TrieNode => ({ children: new Map(), level, leaf: false, value: '' });

/** Trie.add：逐单元建路径，末节点置叶并覆盖值（重复键后者胜）。空键不加。 */
function trieAdd(root: TrieNode, key: string, value: string): void {
  if (key.length < 1) return;
  let node = root;
  for (let i = 0; i < key.length; i += 1) {
    const unit = key.charCodeAt(i);
    let next = node.children.get(unit);
    if (next === undefined) {
      next = newNode(node.level + 1);
      node.children.set(unit, next);
    }
    node = next;
  }
  node.leaf = true;
  node.value = value;
}

/**
 * DictionaryFactory.loadDictionary（reverse=false）：BufferedReader.readLine 切行（\n、\r、\r\n），空行与 `#` 开头的行跳过，
 * 按首个 `=` 切两段（没有 `=` 跳过）；两段都是 1 个单元进 charMap，否则进 Trie 并以键长更新 maxLen（初值 2）。
 * 之后按 BasicDictionary.remove 套排除词：1 个单元的从 charMap 删，其余以自身为值加进 Trie（不替换），maxLen 不变。
 */
function loadDictionary(): Dictionary {
  const charMap = new Map<number, number>();
  const root = newNode(0);
  let maxLen = 2;
  for (const line of T2S_DICT_TEXT.split(/\r\n|\r|\n/)) {
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 0) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1);
    if (key.length === 1 && value.length === 1) {
      charMap.set(key.charCodeAt(0), value.charCodeAt(0));
    } else {
      maxLen = Math.max(key.length, maxLen);
      trieAdd(root, key, value);
    }
  }
  for (const word of T2S_EXCLUDES) {
    if (word.length === 1) charMap.delete(word.charCodeAt(0));
    else trieAdd(root, word, word);
  }
  return { charMap, root, maxLen };
}

let dictionary: Dictionary | undefined;

/**
 * BasicDictionary.convert：PushbackReader(maxLen) 每轮读满 maxLen 个单元（StringReader 之上 BufferedReader 读到尾为止），
 * Trie.bestMatch 从窗口首单元起取最长的叶子；命中写值、退回其后的单元，未命中退回整窗、读 1 个单元按 charMap 换（缺省原样）。
 */
export function t2s(text: string): string {
  dictionary ??= loadDictionary();
  const { charMap, root, maxLen } = dictionary;
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + maxLen, text.length);
    let node: TrieNode | undefined = root;
    let best: TrieNode | undefined;
    for (let k = i; k < end; k += 1) {
      node = node.children.get(text.charCodeAt(k));
      if (node === undefined) break;
      if (node.leaf) best = node;
    }
    if (best !== undefined) {
      out.push(best.value);
      i += best.level;
    } else {
      const unit = text.charCodeAt(i);
      out.push(String.fromCharCode(charMap.get(unit) ?? unit));
      i += 1;
    }
  }
  return out.join('');
}
