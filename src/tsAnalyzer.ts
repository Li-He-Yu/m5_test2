export async function typescriptLanguageHandler(fullCode: string): Promise<{
    mermaidCode: string, 
    lineMapping: string, 
    nodeSequence: string,
    nodeMeta: string
}> {
	return parseTypescriptToMermaid(fullCode);
    // console.error("typescript support is in developing.");
    // throw new Error(
	// 	"typescript support is in developing."
	// );
}

/**
 *  # To do
 *	- Enhance the TS analyzer (functions, classes, try/catch, labeled breaks, etc.).
	- Add block metadata (optional) for scope boxes exactly like the Python idea.
	- Add more languages via Tree-sitter using the same IR approach.
 */

import * as babelParser from "@babel/parser";
import type {
    File, Statement, Node, Program,
    VariableDeclaration, ExpressionStatement, IfStatement,
    ReturnStatement, ForStatement, WhileStatement, CallExpression
} from "@babel/types";
import { nodeIdToLine } from "./extension";

/**
 * @param LineMap
 * 		When you serialize to JSON, object keys are always strings. 
 * 		Even if you think “line 12”, it becomes "12" in JSON.
 * 
 * 		Using Record<string, …> mirrors what you already get back 
		from the Python side ({"1":["node1"], "2":["node2"]...}), 
		so it’s painless to JSON.parse/JSON.stringify.
 */
type LineMap = Record<string, string[]>;
type NodeMeta = Record<string, { label: string; escaped_label: string; line: number | null }>;

// same with 'LanguageAnalyzer.ts'
interface ParseResult {
    mermaidCode: string;        // same shape your Python path returns
    lineMapping: string;        // JSON string map: { "12": ["node7", ...], ... }
    nodeSequence: string;       // JSON string array: ["Start","node1",...,"End"]
    nodeMeta: string;           // JSON string of NodeMeta
}

export function parseTypescriptToMermaid(src: string): ParseResult {
    // console.log("parse function is call");
    const ast: File = babelParser.parse(src, {
        sourceType: "module",
        plugins: ["typescript", "jsx"], // jsx optional; remove if not needed
        ranges: true,                   // we’ll use node.start/node.end for labels
        errorRecovery: true,
    });

    let id = 0;
    const mer: string[] = ["flowchart TD"];
    const seq: string[] = [];
    const lineMap: LineMap = {};
    const meta: NodeMeta = {};
    let current: string | null = "Start";
    const branchEnds: string[] = [];
    const loopStack: string[] = [];
    const functionDefs = new Map<string, string>(); // name -> nodeId
    let anonCounter = 0;


    addStartNode();

    // walk top-level statements in order
    const body = (ast.program as Program).body;
    for (const s of body) {emitStmt(s);}

    // connect tail to End if appropriate
    if (current && current !== "Start") {addEdge(current, "End");}
    // also fan-in any pending branches
    while (branchEnds.length) {addEdge(branchEnds.shift()!, "End");}

    // finalize
	addEndNode();

    return {
        mermaidCode  : mer.join("\n"),
        lineMapping  : JSON.stringify(lineMap),
        nodeSequence : JSON.stringify(seq),
        nodeMeta     : JSON.stringify(meta),
    };

    // ------------ helpers ------------
    function addStartNode() {
        mer.push('    Start([Start])');
        mer.push('    style Start fill:#c8e6c9,stroke:#1b5e20,stroke-width:2px');
        seq.push("Start");
    }
	function addEndNode() :void{
		mer.push('    End([End])');
		mer.push('    style End fill:#ffcdd2,stroke:#b71c1c,stroke-width:2px');
	}

    function nextId(): string { id += 1; return `node${id}`; }

	/**
	 * 	Mermaid renders to SVG/HTML. If your label contains 
	 * 	quotes, <, >, or even parentheses in certain contexts, it can:
		break Mermaid syntax or render as HTML and potentially become unsafe.

		So we convert those characters to HTML entities to keep Mermaid happy
		and your webview safe. It’s basically the TS twin of your Python escape_text.
	 * @param text  : original label string, turn into HTML
	 * @returns 	: after converting string
	 */
    function escapeText(text: string) {
		// const jsonEscaped = JSON.stringify(text).slice(1, -1); // keeps \n
        return text
        	.replace(/&/g,  "&amp;")        // &
            .replace(/"/g,  "#34;")         // "
            .replace(/'/g,  "&apos;")       // '
            .replace(/</g,  "&lt;")         // <
            .replace(/>/g,  "&gt;")         // >
            .replace(/\\/g, "#92;")        // backslash
            .replace(/\(/g, "#40;")        // (
            .replace(/\)/g, "#41;")        // )
            .replace(/\[/g, "#91;")        // [
            .replace(/\]/g, "#93;")        // ]
			.replace(/@/g,  "#64;")		// @
            // .replace(/\s+/g, "")         // (optional) collapse newlines/whitespace
            // .trim();
		;

        /**
         * [Debug record] mermaid render ERROR
         * 
         * 1. remove '&' before '#', e.g., ('@' : "#64")
         *  - Correct version for online mermaid live editor
         *  - Correct for local
         * 
         * 2. double quote, ' " '
         *                    ^
         *                    |
         *  DO NOT use "&quot;" to replace;
         *  Using      "#34;", otherwise cause Syntax Error for unknown reason
         * 
         */
    }

	// This is how we decide what text to put inside each Mermaid node.
    function labelFromRange(n: Node) {
        if (n.start === null || n.end === null) {return n.type;}			// If the node lacks positions, fallback to node.type.
        // a short, readable snippet for labels
        const raw = src.slice(n.start, n.end).trim().replace(/\s+/g, " ");	// Trims & squashes whitespace → nicer labels.
        return raw.length > 120 ? raw.slice(0, 117) + "..." : raw;			// Truncates long code fragments → keeps boxes compact.
    }

    // make a short signature for function
    function fnSignatureFromDecl(fd: any): string {
        const name = fd.id?.name ?? "<anonymous>";
        const params = (fd.params ?? [])
            .map((p: any) =>
                p.type === "Identifier" ? p.name : labelFromRange(p)
            )
            .join(", ");
        return `function ${name}(${params})`;
    }

    // make a short signature for function
    function fnSignatureFromExpr(name: string | null, fn: any): string {
        const params = (fn.params ?? [])
            .map((p: any) =>
                p.type === "Identifier" ? p.name : labelFromRange(p)
            )
            .join(", ");
        if (fn.type === "ArrowFunctionExpression") {
            return `${name ?? "<anon>"} = (${params}) => …`;
        }
        return `${name ?? "<anon>"} = function(${params})`;
    }

    function addLineMap(n: Node, nodeId: string) {
        const line = (n.loc?.start.line ?? null);
        if (line === null) {return;}
        const key = String(line);
        (lineMap[key] ??= []).push(nodeId);
    }

    function addNode(nodeId: string, label: string, shape: "rect"|"diamond"|"round"|"para", n?: Node, style?: string) {
        const escaped = escapeText(label);
        if (!seq.includes(nodeId)) {seq.push(nodeId);}
        if (n) {addLineMap(n, nodeId);}
        meta[nodeId] = { label, escaped_label: escaped, line: n?.loc?.start.line ?? null };

        const shapeLine =
            shape === "diamond"
                ? `    ${nodeId}{"${escaped}"}` 	: shape === "round"
                ? `    ${nodeId}(["${escaped}"])`	: shape === "para"
                ? `    ${nodeId}[/"${escaped}"/]`	: `    ${nodeId}["${escaped}"]`;
		
        mer.push(shapeLine);
        if (style) {mer.push(`    style ${nodeId} ${style}`);}
        mer.push(`    click ${nodeId} nodeClick`);
    }

    function addEdge(from: string, to: string, lbl?: string) {
        if (lbl) {mer.push(`    ${from} -->|${lbl}| ${to}`);}
        else {mer.push(`    ${from} --> ${to}`);}
    }

    // type Statement = BlockStatement | BreakStatement | ContinueStatement | DebuggerStatement 
                    // | DoWhileStatement | EmptyStatement | ExpressionStatement | ForInStatement | ForStatement 
                    // | FunctionDeclaration | IfStatement | LabeledStatement | ReturnStatement 
                    // | SwitchStatement | ThrowStatement | TryStatement | VariableDeclaration 
                    // | WhileStatement | WithStatement | ClassDeclaration 
                    // | ExportAllDeclaration | ExportDefaultDeclaration | ExportNamedDeclaration 
                    // | ForOfStatement | ImportDeclaration 
                    // | DeclareClass | DeclareFunction | DeclareInterface | DeclareModule 
                    // | DeclareModuleExports | DeclareTypeAlias | DeclareOpaqueType | DeclareVariable 
                    // | DeclareExportDeclaration | DeclareExportAllDeclaration 
                    // | InterfaceDeclaration | OpaqueType | TypeAlias | EnumDeclaration 
                    // | TSDeclareFunction | TSInterfaceDeclaration | TSTypeAliasDeclaration | TSEnumDeclaration 
                    // | TSModuleDeclaration | TSImportEqualsDeclaration | TSExportAssignment | TSNamespaceExportDeclaration;
    function emitStmt(s: Statement) {
        console.log("statement type is: " + s.type);
        switch (s.type) {
            case "DeclareFunction":
                console.log("DeclareFunction case");
                emitFunctionDeclaration(s);
                break;
            case "TSDeclareFunction":
                console.log("TSDeclareFunction case");
                emitFunctionDeclaration(s);
                break;
            case "FunctionDeclaration":
                console.log("FunctionDeclaration case");
                emitFunctionDeclaration(s);
                break;
            case "ExportDefaultDeclaration": {
                const d: any = (s as any).declaration;
                if (d?.type === "FunctionDeclaration") {
                    emitFunctionDeclaration(d);
                } else if (
                    d?.type === "FunctionExpression" ||
                    d?.type === "ArrowFunctionExpression"
                ) {
                    // emit as anonymous function def
                    const nodeId = nextId();
                    const sig = fnSignatureFromExpr("default", d);
                    addNode(
                        nodeId,
                        `${sig}`,
                        "rect",
                        d,
                        "fill:#e1f5fe,stroke:#01579b,stroke-width:3px"
                    );
                    const saved = current;
                    current = nodeId;
                    if (d.body?.type === "BlockStatement") {
                        for (const t of d.body.body) {emitStmt(t as any);}
                    }
                    current = saved;
                } else {
                    // not a function: render normally
                    const nodeId = nextId();
                    addNode(nodeId, labelFromRange(s), "rect", s);
                    if (current) {addEdge(current, nodeId);}
                    current = nodeId;
                }
                break;
            }
            case "ExportNamedDeclaration": {
                const d: any = (s as any).declaration;
                if (d?.type === "FunctionDeclaration") {
                    emitFunctionDeclaration(d);
                } else {
                    // fall back
                    const nodeId = nextId();
                    addNode(nodeId, labelFromRange(s), "rect", s);
                    if (current) {addEdge(current, nodeId);}
                    current = nodeId;
                }
                break;
            }

            case "VariableDeclaration": {
                // turn each declarator into an assignment-like node
                for (const d of (s as VariableDeclaration).declarations) {
                    const nodeId = nextId();
                    const lbl = labelFromRange(d);
                    console.log(nodeId + " fall in " + "VariableDeclaration");
                    addNode(
                        nodeId,
                        lbl,
                        "rect",
                        d,
                        "fill:#ffffff,stroke:#424242,stroke-width:2px"
                    );
                    if (current) {
                        addEdge(current, nodeId);
                    }
                    current = nodeId;

                    // then extract any arrow/function expressions
                    maybeEmitFunctionFromVariableDecl(d);
                }
                break;
            }

            case "ExpressionStatement": {
                const e = (s as ExpressionStatement).expression;
                const nodeId = nextId();
                let lbl = labelFromRange(s);
                console.log(nodeId + " fall in " + "ExpressionStatement");
                // make “print(...) / console.log(...)” look like I/O
                if (e.type === "CallExpression") {
                    const ce = e as CallExpression;
                    if (isConsoleLog(ce)) {
                        lbl = labelFromRange(s).replace(/^console\./, "");
                        addNode(
                            nodeId,
                            lbl,
                            "para",
                            s,
                            "fill:#f3e5f5,stroke:#6a1b9a,stroke-width:2px"
                        );
                    } else {
                        // addNode(nodeId, lbl, "rect", s, 'fill:#fce4ec,stroke:#880e4f,stroke-width:2px');
                        emitCallExpression(s.expression);
                    }
                } else {
                    addNode(nodeId, lbl, "rect", s);
                }
                if (current) {
                    addEdge(current, nodeId);
                }
                current = nodeId;
                break;
            }

            case "IfStatement": {
                const ifs = s as IfStatement;
                const condId = nextId();
                const condLbl = "if " + labelFromRange(ifs.test);
                addNode(
                    condId,
                    condLbl,
                    "diamond",
                    ifs,
                    "fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px"
                );
                if (current) {
                    addEdge(current, condId);
                }

                // YES branch
                current = condId;
                const yesHead = emitBlockFirst(ifs.consequent);
                if (yesHead) {
                    fixLastEdgeLabel(condId, "Yes");
                }
                const yesTail = collectTail();

                // NO/ELSE branch (could be nested IfStatement = "else if")
                current = condId;
                let noTail: string | null = null;
                if (ifs.alternate) {
                    const noHead = emitBlockFirst(ifs.alternate);
                    if (noHead) {
                        fixLastEdgeLabel(condId, "No");
                    }
                    noTail = collectTail();
                } else {
                    // no else: allow fall-through with "No" later
                    branchEnds.push(condId); // remember to connect its No
                }

                // after if: both tails become pending
                if (yesTail) {
                    branchEnds.push(yesTail);
                }
                if (noTail) {
                    branchEnds.push(noTail);
                }
                current = null; // control now at pending branch ends
                break;
            }

            case "ReturnStatement": {
                const r = s as ReturnStatement;
                const nodeId = nextId();
                const lbl = r.argument
                    ? "return " + labelFromRange(r.argument)
                    : "return";
                addNode(
                    nodeId,
                    lbl,
                    "round",
                    s,
                    "fill:#ffebee,stroke:#b71c1c,stroke-width:2px"
                );
                if (current) {
                    addEdge(current, nodeId);
                }
                current = null; // path ends
                break;
            }

            case "ForStatement":
            case "WhileStatement": {
                const isWhile = s.type === "WhileStatement";
                const loopId = nextId();
                const header = isWhile
                    ? "while " + labelFromRange((s as WhileStatement).test)
                    : "for (...)"; // keep simple; enhance later with init/test/update
                addNode(
                    loopId,
                    header,
                    isWhile ? "diamond" : "rect",
                    s,
                    "fill:#e3f2fd,stroke:#0d47a1,stroke-width:2px"
                );
                console.log(loopId + " fall in " + "WhileStatement");

                if (current) {
                    addEdge(current, loopId);
                }
                loopStack.push(loopId);

                // body
                current = loopId;
                const bodyFirst = emitBlockFirst(
                    isWhile
                        ? (s as WhileStatement).body
                        : (s as ForStatement).body
                );
                if (isWhile && bodyFirst) {
                    fixLastEdgeLabel(loopId, "True");
                }

                const bodyTail = collectTail();
                if (bodyTail && bodyTail !== loopId) {
                    addEdge(bodyTail, loopId);
                } // back edge
                loopStack.pop();

                // loop false exit continues after loop
                current = loopId;
                break;
            }

            default: {
                // fallback: make a rectangular node
                const nodeId = nextId();
                addNode(nodeId, labelFromRange(s), "rect", s);
                if (current) {
                    addEdge(current, nodeId);
                }
                current = nodeId;
                console.log(nodeId + " fall in " + "default");
                break;
            }
        }
    }

	/**
	 * Purpose: When you have a condition (e.g., if (...) { ... }), 
	 * you want the edge from the diamond to the first statement of the block to get the edge label (“Yes”/“No”).
	 * 
	 * So we:
	 * 	1. emit the first statement early → then we can retro-label the edge as “Yes”.
	 * 	2. emit the rest of the statements in that block.
	 * 
	 * @param n 
	 * @returns 
	 */
    function emitBlockFirst(n: Statement | Node): string | null {
        // emit the *first* statement to label the edge (Yes/No)
        if ("type" in n && n.type === "BlockStatement") {
            const b = (n as any).body as Statement[];
            if (b.length === 0) {return null;}
            emitStmt(b[0]);
            // then the rest
            for (let i = 1; i < b.length; i++) {emitStmt(b[i]);}
            return current;
        } else {
            emitStmt(n as Statement);
            return current;
        }
    }

	/**
	 * Purpose: “Close” a branch and mark that there is no current continuation anymore.
	 * We capture the last node id of the branch (tail), return it (so callers 
	 * can merge/join later), and set current = null to say, “this path is done.”
	 * Used after return, break, or when finishing a branch that doesn’t fall through.
	 * @returns 
	 */
    function collectTail(): string | null {
        const tail = current;
        current = null;
        return tail;
    }

	/**
	 * Purpose: We often output an edge before we know if it’s the “Yes” or “No” 
	 * path (because rendering order vs. semantic info timing).
	 * This function walks backwards through emitted Mermaid lines (mer), finds 
	 * the most recent unlabeled edge from fromId, and patches it with |Yes| or |No|.
	 * 
	 * Think of it as: “I drew the arrow; now that I know it was the true-branch, put the ‘Yes’ label on it.”
	 * 
	 * @param fromId 
	 * @param label 
	 */
    function fixLastEdgeLabel(fromId: string, label: string) {
        for (let i = mer.length - 1; i >= 0; i--) {
            const line = mer[i];
            if (line.startsWith(`    ${fromId} --> `) && !line.includes("|")) {
                mer[i] = line.replace(" --> ", ` -->|${label}| `);
                break;
            }
        }
    }

    function isConsoleLog(ce: CallExpression) {
        // console.log(...) / console.error(...) etc.
        return ce.callee.type === "MemberExpression"
            && ce.callee.object.type === "Identifier"
            && ce.callee.object.name === "console";
    }


    // Handle FunctionDeclaration: create a “Function: name()” node, then visit its body statements.
    // function emitFunctionDeclaration(n: any /* babel types */) {
    //     console.log("emitFunctionDeclaration is called.");

    //     const name = n.id?.name ?? "(anonymous)";
    //     const funcId = nextId(); // however you mint IDs

    //     // register for dotted call links
    //     functionDefs.set(name, funcId);

    //     // add a top-level function box
    //     addNode(
    //         funcId,
    //         `Function: ${name}()`,
    //         "round",
    //         n,
    //         "fill:#e1f5fe,stroke:#01579b,stroke-width:2px"
    //     );

    //     // connect from current flow to the function definition (optional)
    //     if (current) {addEdge(current, funcId);}

    //     // dive into body
    //     const saved = current;
    //     current = funcId;

    //     if (n.body && n.body.type === "BlockStatement") {
    //         // emit first stmt to label the incoming edge (like your if/while pattern)
    //         emitBlockFirst(n.body); // emits all statements; returns tail in `current`
    //     }

    //     // restore
    //     current = saved;
    // }
    
    function emitFunctionDeclaration(fd: any) {
        console.log("emitFunctionDeclaration is called.");

        const name = fd.id?.name ?? `anon_${++anonCounter}`;
        const nodeId = nextId();
        const sig = fnSignatureFromDecl(fd);

        // register for dotted call links
        functionDefs.set(name, nodeId);

        // a visually distinct “definition” node
        addNode(
            nodeId,
            `${sig}`,
            "rect",
            fd,
            "fill:#e1f5fe,stroke:#01579b,stroke-width:3px"
        );
        
        // Traverse body as its own chain hanging off the def node
        const saved = current;
        current = nodeId;
        for (const stmt of fd.body?.body ?? []) {
            emitStmt(stmt as any);
        }
        current = saved;
    }



    // Handle function expressions / arrow functions assigned to identifiers (very common in TS/JS):
    // function maybeEmitFunctionFromVariableDecl(n: any) {
    //     // VariableDeclaration -> declarations[]
    //     for (const d of n.declarations ?? []) {
    //         const name = d.id?.name;
    //         const init = d.init;

    //         const isFn =
    //             init &&
    //             (init.type === "FunctionExpression" ||
    //                 init.type === "ArrowFunctionExpression");

    //         if (!name || !isFn) {continue;}

    //         const funcId = nextId();
    //         functionDefs.set(name, funcId);

    //         addNode(
    //             funcId,
    //             `Function: ${name}()`,
    //             "round",
    //             init,
    //             "fill:#e1f5fe,stroke:#01579b,stroke-width:2px"
    //         );
    //         if (current) {addEdge(current, funcId);}

    //         const saved = current;
    //         current = funcId;

    //         if (init.body?.type === "BlockStatement") {
    //             emitBlockFirst(init.body); // emits the body statements
    //         } else {
    //             // concise arrow fn without block: `const f = x => x+1`
    //             // still add a node for the expression body
    //             addNode(nextId(), labelFromRange(init.body), "rect", init.body);
    //             addEdge(funcId, current!);
    //         }

    //         current = saved;
    //     }
    // }

    function maybeEmitFunctionFromVariableDecl(d: any) {
        const id = d.id;
        const init = d.init;
        if (!id || !init) {return;}

        const name = id.type === "Identifier" ? id.name : null;

        if (
            init.type === "FunctionExpression" ||
            init.type === "ArrowFunctionExpression"
        ) {
            const nodeId = nextId();
            const sig = fnSignatureFromExpr(name, init);
            addNode(
                nodeId,
                `${sig}`,
                "rect",
                init,
                "fill:#e1f5fe,stroke:#01579b,stroke-width:3px"
            );

            if (name) {functionDefs.set(name, nodeId);}

            // Traverse body (for arrow, body can be expr or block)
            const saved = current;
            current = nodeId;
            if (init.body?.type === "BlockStatement") {
                for (const s of init.body.body) {emitStmt(s as any);}
            } else if (init.body) {
                // concise-body arrow: treat the expression like “return <expr>”
                const retId = nextId();
                addNode(
                    retId,
                    "return " + labelFromRange(init.body),
                    "round",
                    init.body,
                    "fill:#ffebee,stroke:#b71c1c,stroke-width:2px"
                );
                addEdge(nodeId, retId);
                current = null;
            }
            current = saved;
        }
    }



    // Detect calls and optionally draw a dotted edge to the function box you registered:
    function emitCallExpression(e: any) {
        const nodeId = nextId();
        const label = renderCallLabel(e); // e.g., "foo(a, b)"
        addNode(
            nodeId,
            label,
            "rect",
            e,
            "fill:#fce4ec,stroke:#880e4f,stroke-width:2px"
        );

        if (current) {addEdge(current, nodeId);}

        // dotted link from call to its definition (if known)
        if (e.callee?.type === "Identifier") {
            const defId = functionDefs.get(e.callee.name);
            if (defId) {mer.push(`    ${nodeId} -.->|calls| ${defId}`);}
        }
        current = nodeId;
    }


    // Make a short, readable label for a CallExpression
    function renderCallLabel(e: any): string {
        const name = renderCallee(e.callee);
        const args = (e.arguments ?? []).map(renderArg).join(", ");
        // If TS generic call like foo<number>(), Babel may put type params on callee
        const hasTypeArgs = !!(
            e.typeArguments ||
            e.typeParameters ||
            (e.callee && (e.callee.typeArguments || e.callee.typeParameters))
        );
        const typeHint = hasTypeArgs ? "<…>" : "";
        return `${name}${typeHint}(${args})`;
    }

    function renderCallee(c: any): string {
        if (!c) {return "<anonymous>";}
        switch (c.type) {
            case "Identifier":
                return c.name;

            case "MemberExpression": {
                const obj = renderObject(c.object);
                const prop = c.computed
                    ? `[${labelFromRange(c.property)}]`
                    : c.property.type === "Identifier"
                    ? c.property.name
                    : labelFromRange(c.property);
                return `${obj}.${prop}`;
            }

            case "CallExpression":
                // chained calls like f()()
                return renderCallLabel(c);

            case "ThisExpression":
                return "this";
            case "Super":
                return "super";

            case "FunctionExpression":
            case "ArrowFunctionExpression":
                return "(fn)"; // IIFE or inline fn

            default:
                // fallback to your snippet helper
                return labelFromRange(c);
        }
    }

    function renderObject(o: any): string {
        if (o.type === "Identifier") {return o.name;}
        if (o.type === "ThisExpression") {return "this";}
        if (o.type === "Super") {return "super";}
        if (o.type === "MemberExpression") {return renderCallee(o);}
        return labelFromRange(o);
    }

    function renderArg(a: any): string {
        if (a.type === "SpreadElement") {return `...${labelFromRange(a.argument)}`;}

        switch (a.type) {
            case "StringLiteral":
            case "NumericLiteral":
            case "BooleanLiteral":
                return JSON.stringify(a.value);
            case "NullLiteral":
                return "null";
            case "Identifier":
                return a.name;
            case "TemplateLiteral": {
                // quick readable form: "Hello ${…}"
                const cooked = (a.quasis ?? [])
                    .map((q: any) => q.value?.cooked ?? "")
                    .join("${…}");
                return "`" + cooked + "`";
            }
            default: {
                // short fallback for arrays/objects/expressions
                const s = labelFromRange(a);
                return s.length > 40 ? s.slice(0, 37) + "..." : s;
            }
        }
    }
}

// line 37: 
//      type LineMap = Record<string, string[]>;
// Record 裡面的東西不見了，沒有印出來
// function 也沒有 dive into function body
// 檢查最後面幾個增加的 function expression handler