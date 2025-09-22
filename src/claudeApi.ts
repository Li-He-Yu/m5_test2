import axios from 'axios';

/**
 * 呼叫 Claude API，將程式碼轉換為 pseudocode
 * @param code - 原始程式碼
 * @returns pseudocode
 */
export async function codeToPseudocode(code: string): Promise<string> {
    const apiKey = process.env.CLAUDE_API_KEY;
    console.log('在 claudeApi.ts 中檢查 API Key:', !!apiKey);
    console.log('所有環境變數:', Object.keys(process.env).filter(key => key.includes('CLAUDE')));

    if (!apiKey) {
        throw new Error('找不到 CLAUDE_API_KEY，請檢查 .env 檔案。當前環境變數中沒有此 Key。');
    }

    // 使用新版 Messages API
    const endpoint = 'https://api.anthropic.com/v1/messages';
    const userMessage = `
You are a code explainer. Your task is to convert any given code into step-by-step pseudocode format. Follow these strict guidelines:

### Output Requirements

- ONLY output the explanation, no comments, or additional text
- Use consistent terminology and structure across all conversions
- Write in clear, readable English-like syntax

### Example Input/Output Format
<examples>

<example>
<user>

for i in range(5):
    for j in range(5):
        print(4)

</user>
<answer>

Printing a pattern:

Step 1: Start outer loop with counter i from 0 to 4
Step 2: For each i, start inner loop with counter j from 0 to 4
Step 3: For each j, print the number 4
Step 4: After inner loop completes, go back to Step 1 for next i
Step 5: Stop when all loops complete (25 times total)

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

Checking value of a:

Step 1: Check if a equals 1
→ If yes, go to Step 2
→ If no, end (no output)
Step 2: Check if a equals 2
→ If yes, print 1 and end
→ If no, go to Step 3
Step 3: Check if a equals 3
→ If yes, print 2 and end
→ If no, go to Step 4
Step 4: Check if a equals 5
→ If yes, print 5 and end
→ If no, go to Step 5
Step 5: Print 3 and end

Note: Logic issue - if a=1, it cannot equal 2, 3, or 5, so always prints 3

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

Finding the n-th Fibonacci number:

Step 1: Look at the value of n
Step 2: Is n bigger than 1?
→ If yes, go to Step 3
→ If no, go to Step 4
Step 3: Get Fibonacci(n-1) + Fibonacci(n-2)
Return this sum
Step 4: Return n (which is either 0 or 1)

</answer>
</example>

</examples>

## explanation Style Guidelines

### Format Rules

- Start with a title describing the overall purpose
- Use "Step X:" format for each step
- Use arrow symbols (→) for conditional branches
- Indent sub-conditions or actions under their parent step
- Keep steps sequential and easy to follow

### Content Structure

- Title: Brief description of what the code does
- Steps: Numbered sequence of actions
- Conditions: Clear yes/no or true/false branches
- Actions: What happens at each step
- Notes: Add only if there's a logic issue or important observation

### Language Style

- Use simple action words (Check, Look at, Get, Return, Print)
- Be specific about values when helpful
- Use parentheses for clarification
- Keep each step concise and clear

### Avoid

-Programming syntax or code
- Technical jargon
- Overly complex explanations
- Unnecessary detail

When given code, respond with only the step-by-step pseudocode using the above conventions:\n${code}`;

    try {
        const response = await axios.post(
            endpoint,
            {
                model: 'claude-3-7-sonnet-20250219',
                max_tokens: 1024,
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

        return response.data.content[0].text;
    } catch (err: any) {
        if (err.response) {
            // API 回傳的錯誤
            console.error('API 錯誤詳情:', err.response.data);
            throw new Error(`Claude API 請求失敗 (${err.response.status}): ${err.response.data.error?.message || err.message}`);
        } else {
            // 網路或其他錯誤
            throw new Error('Claude API 請求失敗: ' + err.message);
        }
    }
} 