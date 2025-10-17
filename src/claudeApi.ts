import axios from 'axios';

export interface LineMapping {
    pythonLine: number;
    pseudocodeLine: number;
}

export interface PseudocodeResult {
    pseudocode: string;
    lineMapping: LineMapping[];
    srcLineToPseudoLines: Map<number, number[]>;
    pseudoLineToSrcLines: Map<number, number[]>;
}

// map 'lineno-of-python : number' to 'lineno-of-pseudocode : number'
function buildLineMapping(pythonCode: string, pseudocode: string): LineMapping[] {
    if (!pythonCode || !pseudocode) {
        console.warn('buildLineMapping: pythonCode or pseudocode is empty');
        return [];
    }

    const pythonLines = pythonCode.split('\n');
    const pseudoLines = pseudocode.split('\n');
    
    const mapping: LineMapping[] = [];
    let pseudoIndex = 0;
    
    let inMultiLineStatement = false;
    let multiLineStartIndex = -1;
    let inDocstring = false;  
    let docstringDelimiter = '';  //記錄 docstring（''' 或 """）
    
    for (let pythonIndex = 0; pythonIndex < pythonLines.length; pythonIndex++) {
        const pythonLine = pythonLines[pythonIndex].trim();
        const rawLine = pythonLines[pythonIndex];
        
        //檢測 docstring 的開始和結束
        if (!inDocstring) {
            // 檢查是否開始 docstring
            if (pythonLine.startsWith('"""') || pythonLine.startsWith("'''")) {
                inDocstring = true;
                docstringDelimiter = pythonLine.startsWith('"""') ? '"""' : "'''";
                
                // 單行 docstring
                const delimiterCount = (pythonLine.match(new RegExp(docstringDelimiter, 'g')) || []).length;
                if (delimiterCount >= 2) {
                    inDocstring = false;
                }
                continue;  // 跳過這一行
            }
        } else {
            // 在 docstring 中，檢查是否結束
            if (pythonLine.includes(docstringDelimiter)) {
                inDocstring = false;
            }
            continue;  // 跳過 docstring 內的所有行
        }
        
        // 跳過空行和單行註解
        if (pythonLine === '' || pythonLine.startsWith('#')) {
            continue;
        }
        
        const openBrackets = (pythonLine.match(/[\(\[\{]/g) || []).length;
        const closeBrackets = (pythonLine.match(/[\)\]\}]/g) || []).length;
        
        if (!inMultiLineStatement && openBrackets > closeBrackets) {
            inMultiLineStatement = true;
            multiLineStartIndex = pythonIndex;
        }
        
        // 檢測多行語句的結束
        if (inMultiLineStatement) {
            const totalOpen = pythonLines.slice(multiLineStartIndex, pythonIndex + 1)
                .join('').match(/[\(\[\{]/g)?.length || 0;
            const totalClose = pythonLines.slice(multiLineStartIndex, pythonIndex + 1)
                .join('').match(/[\)\]\}]/g)?.length || 0;
            
            if (totalOpen === totalClose) {
                inMultiLineStatement = false;
                // 跳過 pseudocode 空行
                while (pseudoIndex < pseudoLines.length && pseudoLines[pseudoIndex].trim() === '') {
                    pseudoIndex++;
                }
                
                // 將多行語句的所有行都映射到同一個 pseudocode 行
                if (pseudoIndex < pseudoLines.length) {
                    for (let i = multiLineStartIndex; i <= pythonIndex; i++) {
                        const line = pythonLines[i].trim();
                        if (line !== '' && !line.startsWith('#')) {
                            mapping.push({
                                pythonLine: i + 1,
                                pseudocodeLine: pseudoIndex + 1
                            });
                        }
                    }
                    pseudoIndex++;
                }
                multiLineStartIndex = -1;
            }
            continue;
        }
        
        // 處理單行語句
        if (!inMultiLineStatement) {
            while (pseudoIndex < pseudoLines.length && pseudoLines[pseudoIndex].trim() === '') {
                pseudoIndex++;
            }
            
            if (pseudoIndex < pseudoLines.length) {
                mapping.push({
                    pythonLine: pythonIndex + 1,
                    pseudocodeLine: pseudoIndex + 1
                });
                pseudoIndex++;
            }
        }
    }
    
    console.log('Line mapping created:', mapping.length, 'mappings');
    console.log('Mapping details:', mapping);  
    return mapping;
}

export async function codeToPseudocode(code: string): Promise<PseudocodeResult> {
    const apiKey = process.env.CLAUDE_API_KEY;
    console.log('在 claudeApi.ts 中檢查 API Key:', !!apiKey);
    console.log('所有環境變數:', Object.keys(process.env).filter(key => key.includes('CLAUDE')));

    if (!apiKey) {
        throw new Error('找不到 CLAUDE_API_KEY，請檢查 .env 檔案。當前環境變數中沒有此 Key。');
    }

    if (!code || code.trim() === '') {
        throw new Error('沒有輸入');
    }

    const endpoint = 'https://api.anthropic.com/v1/messages';
    const userMessage = `
You are a code → pseudocode converter. Convert the given source code into pseudocode AND produce a line mapping.

### Output Requirements

- Return ONLY a single, valid JSON object (no prose before/after).
- JSON schema:
  {
    "pseudocode": "<string with \\n newlines>",
    "mapping": [ [ [<srcLine>...], [<pseudoLine>...] ], ... ]
  }
  - mapping is an array of pairs: [sourceLines[], pseudoLines[]]
  - All line numbers are 1-based positive integers.
  - Keep arrays small: merge only when a single pseudocode line summarizes multiple source lines (e.g., multi-line conditions or list/dict literals).

- Use consistent terminology and structure across all conversions
- Write in clear, readable English-like syntax
- Skip blank lines and comments - only convert actual code statements
- Preserve the indentation structure of the original code

### Example Input/Output Format
<examples>

<example>
<user>

for i in range(5):
    for j in range(5):
        print(4)

</user>
<answer>

FOR i FROM 0 TO 4 DO
    FOR j FROM 0 TO 4 DO
        OUTPUT 4

</answer>
</example>


<example>
<user>

if a==1:
    if a==2:
        print(1)
    elif a==3:
        print(2)
    elif a==5:
        print(5)
    else:
        print(3)

</user>
<answer>

IF a = 1 THEN
    IF a = 2 THEN
        OUTPUT 1
    ELSE IF a = 3 THEN
        OUTPUT 2
    ELSE IF a = 5 THEN
        OUTPUT 5
    ELSE
        OUTPUT 3

</answer>
</example>
<example>
<user>

def fib(n):
    if n > 1:
        return fib(n-1) + fib(n-2)
    return n

</user>
<answer>

FUNCTION fib(n)
    IF n > 1 THEN
        RETURNS fib(n-1) + fib(n-2)
    RETURNS n

</answer>
</example>

<example>
<user>

x = 5
y = x + 3
print(y)

</user>
<answer>

SET x = 5
SET y = x + 3
OUTPUT y

</answer>
</example>

</examples>

### Example Output (JSON)
{
  "pseudocode": "FOR i FROM 0 TO 4 DO\\n    FOR j FROM 0 TO 4 DO\\n        OUTPUT 4",
  "mapping": [
    [[1],[1]],
    [[2],[2]],
    [[3],[3]]
  ]
}

## Pseudocode Style Guidelines

### Control Structures

-IF condition THEN (one line)
-ELSE IF condition THEN (one line)
-ELSE (one line)
-WHILE condition DO (one line)
-FOR variable FROM start TO end DO (one line)
-FOR EACH item IN collection DO (one line)
-REPEAT (one line)
-UNTIL condition (one line)
-BREAK (one line)
-CONTINUE (one line)

### Functions

-FUNCTION functionName(parameters) (one line)
-RETURNS value (one line)
-CALL functionName(arguments) (one line)

### Variables and Operations

-SET variable = value (one line)
-INPUT variable (one line)
-OUTPUT expression (one line)
-INCREMENT variable (one line)
-DECREMENT variable (one line)

### Data Structures

-SET items = [...] for lists (one line)
-SET data = {...} for dictionaries (one line)
-APPEND item TO list (one line)
-REMOVE item FROM list (one line)
-SET variable = LENGTH OF collection (one line)

### Logical Operators

-Use AND, OR, NOT
-Use =, ≠, <, >, ≤, ≥

### File Operations

-OPEN filename AS file (one line)
-READ line FROM file (one line)
-WRITE data TO file (one line)
-CLOSE file (one line)

### Exception Handling

-TRY (one line)
-EXCEPT exception (one line)
-FINALLY (one line)

### Important Rules

- One source statement = one pseudocode line, unless collapsing is clearly more readable (then reflect that in mapping by mapping multiple source lines to one pseudocode line).
- Maintain the exact same indentation level as the original code (use 4 spaces per indentation level to match Python convention)
- Do not add extra lines for END IF, END WHILE, END FUNCTION, etc.
- Preserve the logical flow and structure of the original code
- Nested structures should have correspondingly deeper indentation

## Response Contract
- Return ONLY a single JSON object with keys "pseudocode" and "mapping".
- Ensure JSON is syntactically valid (no trailing commas, no comments).
- Do not include any text outside the JSON.

Now convert the following source code and produce the JSON described above:\n${code}`;

    try {
        const response = await axios.post(
            endpoint,
            {
                model: 'claude-sonnet-4-20250514',
                max_tokens: 2048,
                messages: [
                    {
                        role: 'user',
                        content: userMessage
                    }
                ]
            },
            {
                headers: {
                    'x-api-key': apiKey,
                    'content-type': 'application/json',
                    'anthropic-version': '2023-06-01'
                }
            }
        );

        if (!response.data || !response.data.content || !response.data.content[0]) {
            throw new Error('API 返回格式錯誤');
        }

        const claudResult = response.data.content[0].text;
        
        if (!claudResult || typeof claudResult !== 'string') {
            throw new Error('API 返回的 pseudocode 無效');
        }

        console.log('Pseudocode received, length:', claudResult.length);
        
        const lineMapping = buildLineMapping(code, claudResult);
        const {pseudocode, codelinenoToPseudocodelineno, srcLineToPseudoLines, pseudoLineToSrcLines, entries} = parseLLMResult(claudResult);
        console.log("claud raw reply: ", claudResult);

        return {
            pseudocode,
            lineMapping,
            srcLineToPseudoLines,
            pseudoLineToSrcLines
        };
    } catch (err: any) {
        console.error('codeToPseudocode error:', err);
        
        if (err.response) {
            console.error('API 錯誤詳情:', err.response.data);
            throw new Error(`Claude API 請求失敗 (${err.response.status}): ${err.response.data.error?.message || err.message}`);
        } else if (err.message) {
            throw new Error('Claude API 請求失敗: ' + err.message);
        } else {
            throw new Error('未知錯誤: ' + String(err));
        }
    }
}




// ---------- Types
export type MappingEntry = { src: number[]; pseudo: number[] };

export type ParsedLLM = {
  pseudocode: string;
  /** ⚠️ Arrays as keys are identity-based; use the indexes below for lookups */
  codelinenoToPseudocodelineno: Map<number[], number[]>;
  /** Value-indexed maps for efficient lookups */
  srcLineToPseudoLines: Map<number, number[]>;
  pseudoLineToSrcLines: Map<number, number[]>;
  /** Also keep normalized entries for inspection or re-serialization */
  entries: MappingEntry[];
};

// ---------- A. Parse LLM result JSON into structures
export function parseLLMResult(resultJson: string | { pseudocode: string; mapping: any }): ParsedLLM {
  let obj: any;
  if (typeof resultJson === "string") {
    try {
      obj = JSON.parse(resultJson);
    } catch (e) {
      throw new Error("LLM result is not valid JSON.");
    }
  } else {
    obj = resultJson;
  }

  // Validate shape
  if (!obj || typeof obj.pseudocode !== "string" || !Array.isArray(obj.mapping)) {
    throw new Error('LLM JSON must have { "pseudocode": string, "mapping": [...] }');
  }

  // Parse mapping into normalized entries
  const { entries, codelinenoToPseudocodelineno, srcLineToPseudoLines, pseudoLineToSrcLines } =
    parseCodeToPseudocodeMap(obj.mapping);

  return {
    pseudocode: obj.pseudocode,
    codelinenoToPseudocodelineno,
    srcLineToPseudoLines,
    pseudoLineToSrcLines,
    entries,
  };
}

/**
 * 3) Parse the mapping block into:
 *   - entries:  { src:number[], pseudo:number[] }[]
 *   - codelinenoToPseudocodelineno: Map<number[], number[]>
 *   - srcLineToPseudoLines:  Map<number, number[]>
 *   - pseudoLineToSrcLines:  Map<number, number[]>
 *
 * The incoming format is like:
 *   [
 *     [[1], [1]],
 *     [[3], [2,3]],
 *     [[11,12,13], [9]],
 *     ...
 *   ]
 */
export function parseCodeToPseudocodeMap(
  mapping: unknown
): {
  entries: MappingEntry[];
  codelinenoToPseudocodelineno: Map<number[], number[]>;
  srcLineToPseudoLines: Map<number, number[]>;
  pseudoLineToSrcLines: Map<number, number[]>;
} {
  if (!Array.isArray(mapping)) {
    throw new Error("mapping must be an array");
  }

  const entries: MappingEntry[] = [];
  const codelinenoToPseudocodelineno = new Map<number[], number[]>();

  const srcLineToPseudoLines = new Map<number, number[]>();
  const pseudoLineToSrcLines = new Map<number, number[]>();

  for (const pair of mapping) {
    // Expect each item like: [[src...],[pseudo...]]
    if (!Array.isArray(pair) || pair.length !== 2) continue;

    const srcArr = Array.isArray(pair[0]) ? pair[0].map(n => toPosInt(n)).filter(isFiniteNumber) : [];
    const pseudoArr = Array.isArray(pair[1]) ? pair[1].map(n => toPosInt(n)).filter(isFiniteNumber) : [];

    if (srcArr.length === 0 || pseudoArr.length === 0) continue;

    // Keep canonical sorted, unique
    const src = uniqueSorted(srcArr);
    const pseudo = uniqueSorted(pseudoArr);

    entries.push({ src, pseudo });

    // Spec-required (but identity-based) map
    codelinenoToPseudocodelineno.set(src, pseudo);

    // Build fast inverted indexes
    for (const s of src) {
      const list = srcLineToPseudoLines.get(s) ?? [];
      pushManyUnique(list, pseudo);
      srcLineToPseudoLines.set(s, list);
    }
    for (const p of pseudo) {
      const list = pseudoLineToSrcLines.get(p) ?? [];
      pushManyUnique(list, src);
      pseudoLineToSrcLines.set(p, list);
    }
  }

  // Normalize index lists
  for (const [k, v] of srcLineToPseudoLines) srcLineToPseudoLines.set(k, uniqueSorted(v));
  for (const [k, v] of pseudoLineToSrcLines) pseudoLineToSrcLines.set(k, uniqueSorted(v));

  return { entries, codelinenoToPseudocodelineno, srcLineToPseudoLines, pseudoLineToSrcLines };
}

// ---------- B. Efficient lookup helpers

/** Given a source-code line (1-based), return the mapped pseudocode lines (or empty array). */
export function findPseudoBySrc(
  line: number,
  srcLineToPseudoLines: Map<number, number[]>
): number[] {
  return srcLineToPseudoLines.get(line) ?? [];
}

/** Given a pseudocode line (1-based), return the mapped source-code lines (or empty array). */
export function findSrcByPseudo(
  line: number,
  pseudoLineToSrcLines: Map<number, number[]>
): number[] {
  return pseudoLineToSrcLines.get(line) ?? [];
}

// ---------- Small utils

function toPosInt(n: any): number {
  const v = Number(n);
  if (!Number.isInteger(v) || v <= 0) return NaN;
  return v;
}
function isFiniteNumber(n: number): boolean {
  return Number.isFinite(n);
}
function uniqueSorted(nums: number[]): number[] {
  return Array.from(new Set(nums)).sort((a, b) => a - b);
}
function pushManyUnique(dst: number[], src: number[]) {
  const seen = new Set(dst);
  for (const n of src) if (!seen.has(n)) { dst.push(n); seen.add(n); }
}
