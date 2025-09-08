import * as vscode from 'vscode';
import { 
	nodeIdToLine, nodeIdStringIsStartOrEnd
} from './extension';

// decoration type (top-level, cache it)
const highlightDecorationType = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor('editor.selectionBackground') // or a fixed rgba like 'rgba(255,235,59,0.25)'
});

export function WebViewNodeClickEventHandler(
	editor: typeof vscode.window.activeTextEditor,
	message: any
	):void
{
	// console.log("recieve message: nodeClicked %s", message.nodeId);
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

function highlightEditor(
	editor: typeof vscode.window.activeTextEditor,
	ranges: readonly vscode.Range[]
):void{
	if(!editor){
		console.error('vscode.window.activeTextEditor was undefined when highlight editor');
		return;
	}

	editor.setDecorations(highlightDecorationType, ranges);

	if(!ranges){ return; }
	// scroll to the first line
	editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

export function clearEditor(editor: typeof vscode.window.activeTextEditor):void{
	highlightEditor(editor, []);
}