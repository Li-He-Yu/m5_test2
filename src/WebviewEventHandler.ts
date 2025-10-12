import * as vscode from 'vscode';
import { 
	nodeIdToLine, nodeIdStringIsStartOrEnd, sourceDocUri
} from './extension';

// decoration type (top-level, cache it)
const highlightDecorationType = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor('editor.selectionBackground') // or a fixed rgba like 'rgba(255,235,59,0.25)'
});

export async function WebViewNodeClickEventHandler(
	message: any
	):Promise<void>
{
	const editor = await getSourceEditor();   
	console.log("recieve message: nodeClicked %s", message.nodeId);
	// console.log('active:', vscode.window.activeTextEditor?.document.uri.toString());
	// console.log('param :', editor?.document.uri.toString());
	// console.log('visible:', vscode.window.visibleTextEditors.map(e => e.document.uri.toString()));
	// console.log('source:', sourceDocUri?.toString()); // 產生流程圖時記下的來源檔

	// editor = vscode.window.activeTextEditor;
	//  |___> declare in global
	if (!editor) {
		console.error("could not find vscode.window.activeTextEditor");
		return;
	}
	
	// special case
	if(nodeIdStringIsStartOrEnd(message.nodeId)){
		console.log("%s has no related line num", message.nodeId);
		return;
	}

	// normal case
	// const lines = nodeIdToLine.get(message.nodeId) ?? [];
	// if (lines.length === 0) return;
	const line = nodeIdToLine.get(message.nodeId) ?? '';
	if(!line){
		console.error("can not find related line in mapping: %s", message.nodeId);
		return;
	}

	let lines : number[] = [line];// <<<<<<<<<<  temp using single line version
	const ranges = lines.map(ln => new vscode.Range(ln - 1, 0, ln - 1, Number.MAX_SAFE_INTEGER));

	highlightEditor(editor, ranges);
}

// 取得 flowchart 對應的 editor
// 如果在生成 floqchart 之後切換 TextEditor，會導致 activeTextEditor 變成 undefined 要重新抓
async function getSourceEditor(): Promise<vscode.TextEditor | undefined> {
    if (!sourceDocUri) {
		console.error('找不到 flowchart 對應的 editor, 請打開正確頁面');
		vscode.window.showWarningMessage('找不到 flowchart 對應的 editor, 請打開正確頁面');
        return;
    }

    // 先找可見的, visible editor
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
):void{
	if(!editor){
		console.error('vscode.window.activeTextEditor was undefined when highlight editor');
		return;
	}

	if(!ranges){ 
		console.error('\'range\' was undefined when highlight editor');
		return;
	}

	console.log('renges: ', ranges);
	editor.setDecorations(highlightDecorationType, ranges);

	// scroll to the first line
	editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

export function clearEditor(editor: typeof vscode.window.activeTextEditor):void{
	highlightEditor(editor, []);
}