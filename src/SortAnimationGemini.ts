import * as vscode from 'vscode';

/**
 * The part to send the message to LLM(Gemini)
 * @param orderedForLLM : a JSON object contain nodeId, lineno, statement
 * @param fullCode : original code of python file
 * @returns a string array, contain a list of string, 'nodeId' || 'Start' || 'End'
 */

export async function askGeminiSortCode(orderedForLLM: any, fullCode: string) : Promise<string[]>{
// 1. 將 orderForLLM stringify, 合併成一個 Prompt
// 2. pass 這個字串給 gemini
// 3. 將 sorting 完成的結果存入這邊
// 4. 讀取 sorting 過後的 nodeID
// 5. 修改 'parseNodeSequence' function，可以從這邊接回去原本的接口
//
// 備註: animation 的邏輯是寫在 media/flowview.html 裡面的，extension.ts 後端負責 post 訊息給 webview 前端的 scripts

    // Step 1: 將 orderForLLM stringify, 合併成一個 Prompt
    let systemPrompt :string = getSystemPrompt();
    let jsonObj :any = { ordered: orderedForLLM };
    const userPrompt = getFullPromptString(systemPrompt, fullCode, jsonObj);

    // console.log('userPrompt:');
    // console.log(userPrompt);

    // Step 2: pass 這個字串給 gemini
    // Step 3: 將 sorting 完成的結果存入這邊
    let rawSortResult : string = "";
    try {
        let modelName : string = 'gemini-2.0-flash-lite';
        const genAI = await getGemini();
        const model = genAI.getGenerativeModel({ model: modelName });

        const result = await model.generateContent(userPrompt);
        rawSortResult = result.response.text();
        console.log('raw Gemini response:', rawSortResult);
    } catch (err: any) {
        vscode.window.showErrorMessage(`Gemini error: ${err?.message || err}`);
        return ["Gemini error"];
    }

    // Step 4: 讀取 sorting 過後的 nodeID
    let iterableResult: { executed_orders: number[] };
    try{
        iterableResult = parseLLMJson(rawSortResult);
    } catch (e) {
        console.error("Failed to parse JSON from LLM:", rawSortResult);
        return ["Failed to parse JSON from Gemini"];
    }
    
    // Step 5: 想辦法接入 'parseNodeSequence' function，可以從這邊接回去原本的接口
    // function parseNodeSequence(sequenceStr: string): string[] {...}
    // return string[]
    //         |------->> ['Start', 'node1', 'node2', ..., 'node39', 'End']
    let returnStringArray : string[] = [];
    returnStringArray.push('Start');
    for (const tmpNodeID of iterableResult.executed_orders) {
        returnStringArray.push("node" + tmpNodeID);
    }
    returnStringArray.push('End');

    return returnStringArray;
}

function getSystemPrompt(): string{
    const retString :string =
`Task: Determine the actual execution path for the code below and emit it as JSON.

Rules:
- Output MUST be valid JSON (UTF-8, double quotes, no trailing commas).
- Include every statement that is actually executed in order.
- For condition nodes, include the boolean result.
- Include any printed outputs in the order they occur.
- Do not include nodes that are never reached.

Schema (exact keys):
{
  "executed_orders": number[],             // order indices from my node list, in execution order
}`
;
    return retString;
}

function getFullPromptString(systemPrompt: string, fullCode: string, jsonObj: any, ) {
    const userPrompt = [
        systemPrompt,
        '',
        'Full code:',
        '```python',
        fullCode,
        '```',
        '',
        'JSON payload follows (triple backticks):',
        '```json',
        JSON.stringify(jsonObj, null, 2),
        '```'
    ].join('\n');
    return userPrompt;
}

// If your VS Code runtime < Node 18, uncomment next line to polyfill fetch:
// import { fetch } from 'undici'; (and then: (globalThis as any).fetch = fetch;)

// Read the key & create a tiny Gemini client (in extension.ts)
async function getGemini() {
    // ESM-only SDK -> dynamic import in CJS
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const apiKey =
        vscode.workspace.getConfiguration().get<string>('gemini.apiKey') ||
        process.env.GEMINI_API_KEY;
    // console.log("API key:", apiKey);

    if (!apiKey) {
        console.error("Missing Gemini API key. Set `gemini.apiKey` in Settings or export GEMINI_API_KEY.");
        throw new Error(
            "Missing Gemini API key. Set `gemini.apiKey` in Settings or export GEMINI_API_KEY."
        );
    }

    return new GoogleGenerativeAI(apiKey);
}


/**
 * The part to parse the LLM reply
 * @param raw the raw result return from LLM, which is a JSON-like string
 * @returns JSON object(??)
 */

export function parseLLMJson(raw: string) {
  // 1) trim BOM/whitespace
  let s = raw.trim();

  // 2) If fenced code block, extract inner
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {s = fence[1].trim();}

  // 3) If there’s stray prose, try to grab the first JSON object
  //    (balanced-brace scan to avoid false positives)
  if (!(s.startsWith('{') || s.startsWith('['))) {
    const i = s.indexOf('{');
    if (i >= 0) {s = s.slice(i);}
  }
  // Find the matching closing brace for the first top-level JSON object
  const obj = extractFirstJsonValue(s);
  if (obj) {return JSON.parse(obj);}

  // Fallback: last attempt
  return JSON.parse(s);
}

// Helper: extract the first top-level JSON value ({...} or [...])
function extractFirstJsonValue(s: string): string | null {
    let depth = 0;
    let start = -1;
    let inStr = false;
    let esc = false;
    let quote: '"' | "'" | null = null;

    for (let i = 0; i < s.length; i++) {
        const c = s[i];

        if (inStr) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === quote) { inStr = false; quote = null; }
            continue;
        }

        if (c === '"' || c === "'") { inStr = true; quote = c as '"' | "'"; continue; }
        if (c === '{' || c === '[') {
            if (depth === 0) {start = i;}
            depth++;
        } else if (c === '}' || c === ']') {
            depth--;
            if (depth === 0 && start >= 0) {return s.slice(start, i + 1);}
        }
    }
    return null;
}