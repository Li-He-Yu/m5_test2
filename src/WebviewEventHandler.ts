import * as vscode from 'vscode';
import { 
	nodeIdToLine, nodeIdStringIsStartOrEnd, sourceDocUri
} from './extension';

// decoration type (top-level, cache it)
const highlightDecorationType = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor('editor.selectionBackground') // or a fixed rgba like 'rgba(255,235,59,0.25)'
});

// 用來存儲當前的 webview panel 引用
let currentWebviewPanel: vscode.WebviewPanel | undefined;

// 存儲映射關係
let pseudocodeToLineMapRef: Map<number, number> | undefined;
let lineToNodeMapRef: Map<number, string[]> | undefined;

export function setWebviewPanel(panel: vscode.WebviewPanel | undefined) {
	currentWebviewPanel = panel;
}

export function setMappings(
	pseudocodeToLineMap: Map<number, number>,
	lineToNodeMap: Map<number, string[]>
) {
	pseudocodeToLineMapRef = pseudocodeToLineMap;
	lineToNodeMapRef = lineToNodeMap;
}



// event trigger when:
// 		some node is clicked in webview(flowchart area)
// event do:
// 		1. highlight correspond line in TextEditor of orignal code
// 		2. highlight correspond line in pseudo code
export async function FlowchartNodeClickEventHandler(
	message: any
): Promise<void> {
	const editor = await getSourceEditor();   
	console.log("receive message: nodeClicked %s", message.nodeId);

	// check editor work
	if (!editor) {
		console.error("could not find vscode.window.activeTextEditor");
		return;
	}
	
	// special case
	// check not special case;
	// o.w. exit and clear highlight
	if (nodeIdStringIsStartOrEnd(message.nodeId)) {
		console.log("%s has no related line num", message.nodeId);
		clearEditor(editor);
		// 清除 webview 中的高亮
		if (currentWebviewPanel) {
			currentWebviewPanel.webview.postMessage({
				command: 'clearHighlight'
			});
		}
		return;
	}

	// normal case
	// check the target line exist;
	// o.w. exit and clear highlight
	const line = nodeIdToLine.get(message.nodeId) ?? null;
	if (!line) {
		console.error("can not find related line in mapping: %s", message.nodeId);
		clearEditor(editor);
		// 清除 webview 中的高亮
		if (currentWebviewPanel) {
			currentWebviewPanel.webview.postMessage({
				command: 'clearHighlight'
			});
		}
		return;
	}

	console.log(`Node ${message.nodeId} corresponds to line ${line}`);
	
	// this event do for TextEditor Area
	// 高亮 Python 編輯器中的對應行
	const lines: number[] = [line];
	const ranges = lines.map(ln => new vscode.Range(ln - 1, 0, ln - 1, Number.MAX_SAFE_INTEGER));

	highlightEditor(editor, ranges);
	
	// this event do for Pseudocode Area
	// 發送消息到 webview 高亮對應的 pseudocode 行
	if (currentWebviewPanel) {
		currentWebviewPanel.webview.postMessage({
			command: 'highlightNodesAndPseudocode',
			nodeIds: [message.nodeId],
			pseudocodeLines: [line]
		});
	}
}



// event trigger when:
// 		some line of Pseudocode Area was clicked
// event do: 
// 		1. highlight correspond line in TextEditor of orignal code
// 		2. highlight correspond line in pseudo code                   >>>>>>>>>>>>> 不需要對應關係( highlight 本身 )，可以在前端原地完成；
// 		3. highlight correspond node in flowchart
export async function handlePseudocodeLineClick(
	pseudocodeLine: number
): Promise<void> {
	const editor = await getSourceEditor();
	
	console.log('Pseudocode line clicked:', pseudocodeLine);
	
	if (!editor) {
		console.error("could not find source editor");
		return;
	}
	
	
	
	// this event do for TextEditor Area
	// 從映射中找到對應的 Python 行
	const pythonLine = pseudocodeToLineMapRef?.get(pseudocodeLine);
	
	if (!pythonLine) {
		console.log('No Python line mapping found for pseudocode line:', pseudocodeLine);
		clearEditor(editor);
		// 清除 webview 中的高亮
		if (currentWebviewPanel) {
			currentWebviewPanel.webview.postMessage({
				command: 'clearHighlight'
			});
		}
		return;
	}
	
	console.log('Mapped to Python line:', pythonLine);
	
	// 高亮 Python 編輯器中的對應行
	const lineIndex = pythonLine - 1;
	const range = new vscode.Range(lineIndex, 0, lineIndex, Number.MAX_SAFE_INTEGER);
	
	highlightEditor(editor, [range]);
	


	// this event do for flowchart Area and Pseudocode Area
	// 找到對應的 nodes
	const nodeIds = lineToNodeMapRef?.get(pythonLine);
	console.log('Mapped to nodes:', nodeIds);
	
	// 發送消息到 webview 高亮對應的 flowchart 節點和 pseudocode
	if (currentWebviewPanel) {
		currentWebviewPanel.webview.postMessage({
			command: 'highlightNodesAndPseudocode',
			nodeIds: nodeIds || [],
			pseudocodeLines: [pythonLine]
		});
	}
}



// 取得 flowchart 對應的 editor
// 如果在生成 flowchart 之後切換 TextEditor，會導致 activeTextEditor 變成 undefined 要重新抓
async function getSourceEditor(): Promise<vscode.TextEditor | undefined> {
    if (!sourceDocUri) {
		console.error('找不到 flowchart 對應的 editor, 請打開正確頁面');
		vscode.window.showWarningMessage('找不到 flowchart 對應的 editor, 請打開正確頁面');
        return;
    }

    // 先找可見的 visible editor
    const vis = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === sourceDocUri!.toString()
    );
    if (vis) {
		return vis;
	}

    // 不可見就打開它
	// 在 extension 中，用 'sourceDocUri' 來儲存生成 flowchart 時對應的 source file 路徑
	// 打開會造成一些 race condition，懶得修; 會跟切換頁面後 editor 自動指到第一行發送的 cursor at .. 衝突

    // const doc = await vscode.workspace.openTextDocument(sourceDocUri);
    // return vscode.window.showTextDocument(doc, {
    //     preview: false,
    //     viewColumn: vscode.ViewColumn.One,
    // });
}

function highlightEditor(
	editor: typeof vscode.window.activeTextEditor,
	ranges: readonly vscode.Range[]
): void {
	if (!editor) {
		console.error('vscode.window.activeTextEditor was undefined when highlight editor');
		return;
	}

	if (!ranges) { 
		console.error('\'range\' was undefined when highlight editor');
		return;
	}

	console.log('ranges: ', ranges);
	editor.setDecorations(highlightDecorationType, ranges);

	// scroll to the first line
	if (ranges.length > 0) {
		editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}
}

export function clearEditor(editor: typeof vscode.window.activeTextEditor): void {
	highlightEditor(editor, []);
}