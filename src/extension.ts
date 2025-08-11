import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';

// 儲存當前 webview panel 的參考
let currentPanel: vscode.WebviewPanel | undefined;

// 儲存行號到節點ID的映射
let lineToNodeMap: Map<number, string[]> = new Map();

export function activate(context: vscode.ExtensionContext) {
    // 註冊生成流程圖命令
    let generateDisposable = vscode.commands.registerCommand('m5-test2.generate', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active Python file');
            return;
        }

        const document = editor.document;
        if (document.languageId !== 'python') {
            vscode.window.showErrorMessage('Current file is not a Python file');
            return;
        }

        const code = document.getText();
        
        try {
            // 使用 Python AST 來解析程式碼，並獲取行號映射
            const { mermaidCode, lineMapping } = await parsePythonWithAST(code);
            
            console.log('Generated Mermaid code:');
            console.log(mermaidCode);
            console.log('Line mapping:', lineMapping);
            
            // 解析行號映射
            lineToNodeMap = parseLineMapping(lineMapping);
            console.log('Parsed line to node map:', Array.from(lineToNodeMap.entries()));
            
            // 創建或更新 Webview 面板
            if (currentPanel) {
                currentPanel.reveal(vscode.ViewColumn.Two);
            } else {
                currentPanel = vscode.window.createWebviewPanel(
                    'pythonFlowchart',
                    'Python Flowchart',
                    vscode.ViewColumn.Two,
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true
                    }
                );

                currentPanel.onDidDispose(() => {
                    currentPanel = undefined;
                });
            }

            currentPanel.webview.html = getWebviewContent(mermaidCode);
            
            // 監聽來自 webview 的消息（這個保留但不會用到）
            currentPanel.webview.onDidReceiveMessage(
                message => {
                    switch (message.command) {
                        case 'nodeClicked':
                            // 現在不需要這個功能
                            break;
                    }
                },
                undefined,
                context.subscriptions
            );
            
        } catch (error) {
            vscode.window.showErrorMessage(`Error generating flowchart: ${error}`);
        }
    });

    // 註冊游標位置變化事件 - 這是主要的互動邏輯
    let selectionDisposable = vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!currentPanel) {
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'python') {
            return;
        }

        // 獲取當前行號（從1開始）
        const lineNumber = e.selections[0].active.line + 1;
        
        console.log('Cursor at line:', lineNumber);
        console.log('Line to node map:', Array.from(lineToNodeMap.entries()));
        
        // 查找對應的節點ID
        const nodeIds = lineToNodeMap.get(lineNumber);
        if (nodeIds && nodeIds.length > 0) {
            console.log('Found nodes for line', lineNumber, ':', nodeIds);
            // 發送消息到 webview，高亮對應的節點
            currentPanel.webview.postMessage({
                command: 'highlightNodes',
                nodeIds: nodeIds
            });
        } else {
            console.log('No nodes found for line', lineNumber);
            // 清除高亮
            currentPanel.webview.postMessage({
                command: 'clearHighlight'
            });
        }
    });

    context.subscriptions.push(generateDisposable);
    context.subscriptions.push(selectionDisposable);
}

/**
 * 解析行號映射字符串
 */
function parseLineMapping(mappingStr: string): Map<number, string[]> {
    const map = new Map<number, string[]>();
    try {
        console.log('Raw line mapping string:', mappingStr);
        const mapping = JSON.parse(mappingStr);
        console.log('Parsed JSON mapping:', mapping);
        
        for (const [line, nodes] of Object.entries(mapping)) {
            const lineNum = parseInt(line);
            map.set(lineNum, nodes as string[]);
            console.log(`Line ${lineNum} maps to nodes:`, nodes);
        }
    } catch (e) {
        console.error('Error parsing line mapping:', e);
    }
    console.log('Final line to node map:', Array.from(map.entries()));
    return map;
}

/**
 * 生成 Python AST 解析器類別（加入行號追蹤）
 */
function generatePythonASTClass(): string {
    const imports = () => `
import ast
import json
import sys
`;

    const classDefinition = () => `
class FlowchartGenerator(ast.NodeVisitor):
    """AST 訪問器，用於生成 Mermaid 流程圖並追蹤行號"""
    
    def __init__(self):
        self.node_id = 0
        self.mermaid_lines = ['flowchart TD']
        self.current_node = 'Start'
        self.function_defs = {}
        self.loop_stack = []
        self.if_stack = []
        self.in_function = False
        self.current_function = None
        self.branch_ends = []
        self.pending_no_label = None
        
        # 行號到節點ID的映射
        self.line_to_node = {}
        
        # 添加開始節點
        self.mermaid_lines.append('    Start([Start])')
        self.mermaid_lines.append('    style Start fill:#c8e6c9,stroke:#1b5e20,stroke-width:2px')
`;

    const helperMethods = () => `
    def get_next_id(self):
        """生成下一個節點 ID"""
        self.node_id += 1
        return f'node{self.node_id}'
    
    def escape_text(self, text):
        """轉義 Mermaid 特殊字符"""
        return (text.replace('"', '&quot;')
                   .replace("'", '&apos;')
                   .replace('(', '&#40;')
                   .replace(')', '&#41;')
                   .replace('<', '&lt;')
                   .replace('>', '&gt;'))
    
    def add_line_mapping(self, node, node_id):
        """添加行號到節點ID的映射"""
        if hasattr(node, 'lineno'):
            line = node.lineno
            if line not in self.line_to_node:
                self.line_to_node[line] = []
            self.line_to_node[line].append(node_id)
    
    def add_node(self, node_id, label, shape='rectangle', style=None, source_node=None):
        """添加節點到 Mermaid 圖"""
        escaped_label = self.escape_text(label)
        
        # 添加行號映射
        if source_node:
            self.add_line_mapping(source_node, node_id)
        
        if shape == 'rectangle':
            self.mermaid_lines.append(f'    {node_id}["{escaped_label}"]')
        elif shape == 'diamond':
            self.mermaid_lines.append(f'    {node_id}{{"{escaped_label}"}}')
        elif shape == 'parallelogram':
            self.mermaid_lines.append(f'    {node_id}[/"{escaped_label}"/]')
        elif shape == 'rounded':
            self.mermaid_lines.append(f'    {node_id}(["{escaped_label}"])')
        elif shape == 'double':
            self.mermaid_lines.append(f'    {node_id}[["{escaped_label}"]]')
        elif shape == 'invisible':
            self.mermaid_lines.append(f'    {node_id}[ ]')
            self.mermaid_lines.append(f'    style {node_id} fill:transparent,stroke:transparent')
            return
        
        if style:
            self.mermaid_lines.append(f'    style {node_id} {style}')
        
        # 添加點擊事件
        self.mermaid_lines.append(f'    click {node_id} nodeClick')
    
    def add_edge(self, from_node, to_node, label=None):
        """添加邊到 Mermaid 圖"""
        if label:
            self.mermaid_lines.append(f'    {from_node} -->|{label}| {to_node}')
        else:
            self.mermaid_lines.append(f'    {from_node} --> {to_node}')
    
    def add_dotted_edge(self, from_node, to_node, label='calls'):
        """添加虛線邊（用於函式呼叫）"""
        self.mermaid_lines.append(f'    {from_node} -.->|{label}| {to_node}')
`;

    const visitMethods = () => `
    def visit_Module(self, node):
        """訪問模組節點"""
        # 先處理所有函式定義
        for item in node.body:
            if isinstance(item, ast.FunctionDef) or isinstance(item, ast.ClassDef):
                self.visit(item)
        
        # 重置狀態，開始處理主程式
        self.current_node = 'Start'
        
        # 處理主程式（非函式定義的部分）
        for item in node.body:
            if not isinstance(item, ast.FunctionDef) and not isinstance(item, ast.ClassDef):
                self.visit(item)
        
        # 添加結束節點
        end_node = 'End'
        self.mermaid_lines.append('    End([End])')
        self.mermaid_lines.append('    style End fill:#ffcdd2,stroke:#b71c1c,stroke-width:2px')
        
        # 處理可能的分支合併情況
        if self.branch_ends and not self.current_node:
            for end_node_id in self.branch_ends:
                if end_node_id:
                    if end_node_id == self.pending_no_label:
                        self.add_edge(end_node_id, end_node, 'No')
                        self.pending_no_label = None
                    else:
                        self.add_edge(end_node_id, end_node)
            self.branch_ends = []
        elif self.current_node:
            self.add_edge(self.current_node, end_node)
    
    def visit_Import(self, node):
        """處理 import 語句"""
        node_id = self.get_next_id()
        import_names = ', '.join([alias.name for alias in node.names])
        self.add_node(node_id, f'import {import_names}', 'rectangle', 
                     'fill:#fff3e0,stroke:#e65100,stroke-width:2px', node)
        if self.current_node:
            self.add_edge(self.current_node, node_id)
        self.current_node = node_id
    
    def visit_ImportFrom(self, node):
        """處理 from ... import ... 語句"""
        node_id = self.get_next_id()
        import_names = ', '.join([alias.name for alias in node.names])
        module = node.module or ''
        self.add_node(node_id, f'from {module} import {import_names}', 'rectangle',
                     'fill:#fff3e0,stroke:#e65100,stroke-width:2px', node)
        if self.current_node:
            self.add_edge(self.current_node, node_id)
        self.current_node = node_id
    
    def visit_FunctionDef(self, node):
        """處理函式定義"""
        func_id = f'func_{node.name}'
        self.function_defs[node.name] = func_id
        
        # 創建函式節點
        self.add_node(func_id, f'Function: {node.name}()', 'double',
                     'fill:#e1f5fe,stroke:#01579b,stroke-width:3px', node)
        
        # 保存當前狀態
        old_current = self.current_node
        old_in_function = self.in_function
        old_branch_ends = self.branch_ends[:]
        
        # 設置函式內部狀態
        self.in_function = True
        self.current_node = func_id
        self.branch_ends = []
        
        # 訪問函式體
        for stmt in node.body:
            self.visit(stmt)
        
        # 恢復狀態
        self.current_node = old_current
        self.in_function = old_in_function
        self.branch_ends = old_branch_ends
    
    def visit_ClassDef(self, node):
        """處理類別定義"""
        node_id = self.get_next_id()
        self.add_node(node_id, f'Class: {node.name}', 'rectangle',
                     'fill:#f3e5f5,stroke:#4a148c,stroke-width:2px', node)
        if self.current_node:
            self.add_edge(self.current_node, node_id)
        self.current_node = node_id
    
    def visit_If(self, node):
        """處理 if 語句"""
        if_id = self.get_next_id()
        
        condition = self.get_source_segment(node.test)
        self.add_node(if_id, f'if {condition}', 'diamond',
                     'fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px', node)
        
        if self.current_node:
            self.add_edge(self.current_node, if_id)
        
        self.branch_ends = []
        self.current_node = if_id
        
        if node.body:
            self.visit(node.body[0])
            self.fix_last_edge_label(if_id, 'Yes')
            
            for stmt in node.body[1:]:
                self.visit(stmt)
            
            if self.current_node and not self.ends_with_return(node.body):
                self.branch_ends.append(self.current_node)
        
        if node.orelse:
            self.current_node = if_id
            
            if len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If):
                elif_branches = self.process_elif_chain(node.orelse[0], if_id)
                self.branch_ends.extend(elif_branches)
            else:
                self.visit(node.orelse[0])
                self.fix_last_edge_label(if_id, 'No')
                
                for stmt in node.orelse[1:]:
                    self.visit(stmt)
                
                if self.current_node and not self.ends_with_return(node.orelse):
                    self.branch_ends.append(self.current_node)
        else:
            self.branch_ends.append(if_id)
            self.pending_no_label = if_id
        
        if len(self.branch_ends) > 1:
            self.current_node = None
        elif len(self.branch_ends) == 1:
            self.current_node = self.branch_ends[0]
            self.branch_ends = []
        else:
            self.current_node = None
    
    def process_elif_chain(self, elif_node, parent_id):
        """處理 elif 鏈"""
        elif_id = self.get_next_id()
        
        condition = self.get_source_segment(elif_node.test)
        self.add_node(elif_id, f'if {condition}', 'diamond',
                     'fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px', elif_node)
        
        self.add_edge(parent_id, elif_id, 'No')
        
        branch_ends = []
        self.current_node = elif_id
        
        if elif_node.body:
            self.visit(elif_node.body[0])
            self.fix_last_edge_label(elif_id, 'Yes')
            
            for stmt in elif_node.body[1:]:
                self.visit(stmt)
            
            if self.current_node and not self.ends_with_return(elif_node.body):
                branch_ends.append(self.current_node)
        
        if elif_node.orelse:
            self.current_node = elif_id
            
            if len(elif_node.orelse) == 1 and isinstance(elif_node.orelse[0], ast.If):
                next_elif_branches = self.process_elif_chain(elif_node.orelse[0], elif_id)
                branch_ends.extend(next_elif_branches)
            else:
                self.visit(elif_node.orelse[0])
                self.fix_last_edge_label(elif_id, 'No')
                
                for stmt in elif_node.orelse[1:]:
                    self.visit(stmt)
                
                if self.current_node and not self.ends_with_return(elif_node.orelse):
                    branch_ends.append(self.current_node)
        else:
            branch_ends.append(elif_id)
            self.pending_no_edge = elif_id
        
        return branch_ends
    
    def ends_with_return(self, body):
        """檢查代碼塊是否以 return 語句結束"""
        if not body:
            return False
        last_stmt = body[-1]
        return isinstance(last_stmt, ast.Return)
    
    def fix_last_edge_label(self, from_node, label):
        """修正最後一條從指定節點出發的邊的標籤"""
        for i in range(len(self.mermaid_lines) - 1, -1, -1):
            if f'{from_node} -->' in self.mermaid_lines[i] and '|' not in self.mermaid_lines[i]:
                self.mermaid_lines[i] = self.mermaid_lines[i].replace(' --> ', f' -->|{label}| ')
                break
    
    def visit_For(self, node):
        """處理 for 迴圈"""
        for_id = self.get_next_id()
        
        target = self.get_source_segment(node.target)
        iter_expr = self.get_source_segment(node.iter)
        self.add_node(for_id, f'for {target} in {iter_expr}', 'rectangle',
                     'fill:#e3f2fd,stroke:#0d47a1,stroke-width:2px', node)
        
        if self.current_node:
            self.add_edge(self.current_node, for_id)
        
        self.current_node = for_id
        for stmt in node.body:
            self.visit(stmt)
        
        if self.current_node and self.current_node != for_id:
            self.add_edge(self.current_node, for_id)
        
        self.current_node = for_id
    
    def visit_While(self, node):
        """處理 while 迴圈"""
        while_id = self.get_next_id()
        
        condition = self.get_source_segment(node.test)
        self.add_node(while_id, f'while {condition}', 'diamond',
                     'fill:#e3f2fd,stroke:#0d47a1,stroke-width:2px', node)
        
        if self.current_node:
            self.add_edge(self.current_node, while_id)
        
        self.current_node = while_id
        
        first_in_body = True
        for stmt in node.body:
            if first_in_body:
                self.visit(stmt)
                self.fix_last_edge_label(while_id, 'True')
                first_in_body = False
            else:
                self.visit(stmt)
        
        if self.current_node and self.current_node != while_id:
            self.add_edge(self.current_node, while_id)
        
        self.current_node = while_id
    
    def visit_Return(self, node):
        """處理 return 語句"""
        node_id = self.get_next_id()
        
        if node.value:
            value = self.get_source_segment(node.value)
            self.add_node(node_id, f'return {value}', 'rounded',
                         'fill:#ffebee,stroke:#b71c1c,stroke-width:2px', node)
        else:
            self.add_node(node_id, 'return', 'rounded',
                         'fill:#ffebee,stroke:#b71c1c,stroke-width:2px', node)
        
        if self.current_node:
            self.add_edge(self.current_node, node_id)
        
        if node.value and isinstance(node.value, ast.Call):
            if isinstance(node.value.func, ast.Name):
                func_name = node.value.func.id
                if func_name in self.function_defs:
                    self.add_dotted_edge(node_id, self.function_defs[func_name])
        
        self.current_node = None
    
    def visit_Expr(self, node):
        """處理表達式語句"""
        if self.branch_ends and not self.current_node:
            if isinstance(node.value, ast.Call):
                call_node = node.value
                node_id = self.get_next_id()
                
                if isinstance(call_node.func, ast.Name):
                    func_name = call_node.func.id
                    
                    if func_name == 'print':
                        args = ', '.join([self.get_source_segment(arg) for arg in call_node.args])
                        self.add_node(node_id, f'print({args})', 'parallelogram',
                                     'fill:#f3e5f5,stroke:#6a1b9a,stroke-width:2px', node)
                    elif func_name == 'input':
                        args = ', '.join([self.get_source_segment(arg) for arg in call_node.args])
                        self.add_node(node_id, f'input({args})', 'parallelogram',
                                     'fill:#e8eaf6,stroke:#283593,stroke-width:2px', node)
                    else:
                        args = ', '.join([self.get_source_segment(arg) for arg in call_node.args])
                        self.add_node(node_id, f'Call {func_name}({args})', 'rectangle',
                                     'fill:#fce4ec,stroke:#880e4f,stroke-width:3px', node)
                        
                        if func_name in self.function_defs:
                            self.add_dotted_edge(node_id, self.function_defs[func_name])
                elif isinstance(call_node.func, ast.Attribute):
                    method_name = call_node.func.attr
                    obj = self.get_source_segment(call_node.func.value)
                    args = ', '.join([self.get_source_segment(arg) for arg in call_node.args])
                    self.add_node(node_id, f'{obj}.{method_name}({args})', 'rectangle',
                                 'fill:#fce4ec,stroke:#880e4f,stroke-width:2px', node)
                
                for end_node in self.branch_ends:
                    if end_node:
                        if end_node == self.pending_no_label:
                            self.add_edge(end_node, node_id, 'No')
                            self.pending_no_label = None
                        else:
                            self.add_edge(end_node, node_id)
                
                self.branch_ends = []
                self.current_node = node_id
        else:
            if isinstance(node.value, ast.Call):
                call_node = node.value
                node_id = self.get_next_id()
                
                if isinstance(call_node.func, ast.Name):
                    func_name = call_node.func.id
                    
                    if func_name == 'print':
                        args = ', '.join([self.get_source_segment(arg) for arg in call_node.args])
                        self.add_node(node_id, f'print({args})', 'parallelogram',
                                     'fill:#f3e5f5,stroke:#6a1b9a,stroke-width:2px', node)
                        
                        for arg in call_node.args:
                            if isinstance(arg, ast.Call) and isinstance(arg.func, ast.Name):
                                called_func = arg.func.id
                                if called_func in self.function_defs:
                                    self.add_dotted_edge(node_id, self.function_defs[called_func])
                    elif func_name == 'input':
                        args = ', '.join([self.get_source_segment(arg) for arg in call_node.args])
                        self.add_node(node_id, f'input({args})', 'parallelogram',
                                     'fill:#e8eaf6,stroke:#283593,stroke-width:2px', node)
                    else:
                        args = ', '.join([self.get_source_segment(arg) for arg in call_node.args])
                        self.add_node(node_id, f'Call {func_name}({args})', 'rectangle',
                                     'fill:#fce4ec,stroke:#880e4f,stroke-width:3px', node)
                        
                        if func_name in self.function_defs:
                            self.add_dotted_edge(node_id, self.function_defs[func_name])
                elif isinstance(call_node.func, ast.Attribute):
                    method_name = call_node.func.attr
                    obj = self.get_source_segment(call_node.func.value)
                    args = ', '.join([self.get_source_segment(arg) for arg in call_node.args])
                    self.add_node(node_id, f'{obj}.{method_name}({args})', 'rectangle',
                                 'fill:#fce4ec,stroke:#880e4f,stroke-width:2px', node)
                
                if self.current_node:
                    if self.pending_no_label == self.current_node:
                        self.add_edge(self.current_node, node_id, 'No')
                        self.pending_no_label = None
                    else:
                        self.add_edge(self.current_node, node_id)
                
                self.current_node = node_id
    
    def visit_Assign(self, node):
        """處理賦值語句"""
        if self.branch_ends and not self.current_node:
            node_id = self.get_next_id()
            targets = ', '.join([self.get_source_segment(t) for t in node.targets])
            value = self.get_source_segment(node.value)
            
            self.add_node(node_id, f'{targets} = {value}', 'rectangle',
                         'fill:#ffffff,stroke:#424242,stroke-width:2px', node)
            
            for end_node in self.branch_ends:
                if end_node:
                    if end_node == self.pending_no_label:
                        self.add_edge(end_node, node_id, 'No')
                        self.pending_no_label = None
                    else:
                        self.add_edge(end_node, node_id)
            
            self.branch_ends = []
            self.current_node = node_id
        else:
            node_id = self.get_next_id()
            
            targets = ', '.join([self.get_source_segment(t) for t in node.targets])
            value = self.get_source_segment(node.value)
            
            self.add_node(node_id, f'{targets} = {value}', 'rectangle',
                         'fill:#ffffff,stroke:#424242,stroke-width:2px', node)
            
            if self.current_node:
                if self.pending_no_label == self.current_node:
                    self.add_edge(self.current_node, node_id, 'No')
                    self.pending_no_label = None
                else:
                    self.add_edge(self.current_node, node_id)
            
            if isinstance(node.value, ast.Call):
                if isinstance(node.value.func, ast.Name):
                    func_name = node.value.func.id
                    if func_name in self.function_defs:
                        self.add_dotted_edge(node_id, self.function_defs[func_name])
                        self.mermaid_lines.append(f'    style {node_id} stroke:#e91e63,stroke-width:3px')
            
            self.current_node = node_id
    
    def visit_Try(self, node):
        """處理 try-except 語句"""
        try_id = self.get_next_id()
        self.add_node(try_id, 'try-except', 'rectangle',
                     'fill:#fff9c4,stroke:#f57c00,stroke-width:2px', node)
        
        if self.current_node:
            self.add_edge(self.current_node, try_id)
        
        self.current_node = try_id
    
    def get_source_segment(self, node):
        """獲取節點的源代碼片段"""
        if isinstance(node, ast.Name):
            return node.id
        elif isinstance(node, ast.Constant):
            return repr(node.value)
        elif isinstance(node, ast.BinOp):
            left = self.get_source_segment(node.left)
            right = self.get_source_segment(node.right)
            op = self.get_op_symbol(node.op)
            return f'{left} {op} {right}'
        elif isinstance(node, ast.Compare):
            left = self.get_source_segment(node.left)
            ops = [self.get_op_symbol(op) for op in node.ops]
            comparators = [self.get_source_segment(c) for c in node.comparators]
            result = left
            for op, comp in zip(ops, comparators):
                result += f' {op} {comp}'
            return result
        elif isinstance(node, ast.Call):
            func = self.get_source_segment(node.func)
            args = ', '.join([self.get_source_segment(arg) for arg in node.args])
            return f'{func}({args})'
        elif isinstance(node, ast.Attribute):
            value = self.get_source_segment(node.value)
            return f'{value}.{node.attr}'
        elif isinstance(node, ast.Subscript):
            value = self.get_source_segment(node.value)
            slice_val = self.get_source_segment(node.slice)
            return f'{value}[{slice_val}]'
        elif isinstance(node, ast.List):
            elements = ', '.join([self.get_source_segment(e) for e in node.elts])
            return f'[{elements}]'
        elif isinstance(node, ast.Tuple):
            elements = ', '.join([self.get_source_segment(e) for e in node.elts])
            return f'({elements})'
        elif isinstance(node, ast.Dict):
            items = ', '.join([f'{self.get_source_segment(k)}: {self.get_source_segment(v)}' 
                             for k, v in zip(node.keys, node.values)])
            return f'{{{items}}}'
        else:
            return str(type(node).__name__)
    
    def get_op_symbol(self, op):
        """獲取運算符號"""
        op_map = {
            ast.Add: '+', ast.Sub: '-', ast.Mult: '*', ast.Div: '/',
            ast.Mod: '%', ast.Pow: '**', ast.FloorDiv: '//',
            ast.Eq: '==', ast.NotEq: '!=', ast.Lt: '<', ast.LtE: '<=',
            ast.Gt: '>', ast.GtE: '>=', ast.Is: 'is', ast.IsNot: 'is not',
            ast.In: 'in', ast.NotIn: 'not in',
            ast.And: 'and', ast.Or: 'or', ast.Not: 'not'
        }
        return op_map.get(type(op), '?')
    
    def generate_mermaid(self):
        """生成最終的 Mermaid 程式碼"""
        return '\\n'.join(self.mermaid_lines)
    
    def get_line_mapping(self):
        """獲取行號到節點ID的映射"""
        return json.dumps(self.line_to_node)
`;

    return [
        imports(),
        classDefinition(),
        helperMethods(),
        visitMethods()
    ].join('');
}

/**
 * 生成 Python 主程式
 */
function generatePythonMain(code: string): string {
    // 不要改變原始程式碼的格式，保持原樣
    const escapedCode = code
        .replace(/\\/g, '\\\\')
        .replace(/'''/g, "\\'''")
        .replace(/"""/g, '\\"""');
    
    return `
# 主程式
try:
    code = '''${escapedCode}'''
    
    # 顯示每一行的內容和行號（用於調試）
    import sys
    lines = code.split('\\n')
    for i, line in enumerate(lines, 1):
        print(f"Line {i}: {repr(line)}", file=sys.stderr)
    
    # 解析 AST
    tree = ast.parse(code)
    
    # 生成流程圖
    generator = FlowchartGenerator()
    generator.visit(tree)
    
    # 輸出 Mermaid 程式碼
    print(generator.generate_mermaid())
    print("---LINE_MAPPING---")
    
    # 輸出行號映射
    line_mapping = generator.get_line_mapping()
    print(line_mapping)
    
    # 輸出詳細的映射信息到 stderr（用於調試）
    print(f"Line mapping details: {generator.line_to_node}", file=sys.stderr)
    
    # 檢查並顯示 AST 節點的實際行號
    for node in ast.walk(tree):
        if hasattr(node, 'lineno'):
            node_type = type(node).__name__
            print(f"AST Node {node_type} at line {node.lineno}", file=sys.stderr)
    
except SyntaxError as e:
    print(f"Syntax Error: {e}", file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    import traceback
    traceback.print_exc(file=sys.stderr)
    sys.exit(1)
`;
}

// 使用 Python 的 AST 模組來解析程式碼
function parsePythonWithAST(code: string): Promise<{mermaidCode: string, lineMapping: string}> {
    return new Promise((resolve, reject) => {
        const pythonScript = generatePythonASTClass() + generatePythonMain(code);
        
        const python = spawn('python', ['-c', pythonScript]);
        
        let output = '';
        let error = '';
        
        python.stdout.on('data', (data) => {
            output += data.toString();
        });
        
        python.stderr.on('data', (data) => {
            const errorStr = data.toString();
            error += errorStr;
            // 輸出所有調試信息到 console
            console.log('Python stderr:', errorStr);
        });
        
        python.on('close', (exitCode) => {
            if (exitCode !== 0) {
                console.error('Python script failed with exit code:', exitCode);
                console.error('Full error output:', error);
                reject(new Error(error || 'Python script failed'));
            } else {
                const parts = output.trim().split('---LINE_MAPPING---');
                const mermaidCode = parts[0].trim();
                const lineMapping = parts[1]?.trim() || '{}';
                
                console.log('Raw Python output line mapping:', lineMapping);
                
                resolve({
                    mermaidCode: mermaidCode,
                    lineMapping: lineMapping
                });
            }
        });
        
        python.on('error', (err) => {
            reject(new Error(`Failed to spawn Python: ${err.message}`));
        });
    });
}

// Webview 內容
function getWebviewContent(mermaidCode: string): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Python Flowchart</title>
        <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
        <style>
            body {
                font-family: Arial, sans-serif;
                padding: 20px;
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
            }
            h1 {
                color: var(--vscode-editor-foreground);
                border-bottom: 2px solid var(--vscode-panel-border);
                padding-bottom: 10px;
            }
            .controls {
                margin: 20px 0;
                display: flex;
                gap: 10px;
            }
            button {
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 8px 16px;
                cursor: pointer;
                border-radius: 4px;
            }
            button:hover {
                background-color: var(--vscode-button-hoverBackground);
            }
            #mermaid-container {
                background-color: white;
                border-radius: 8px;
                padding: 20px;
                margin-top: 20px;
                overflow: auto;
                max-height: 80vh;
            }
            .mermaid {
                text-align: center;
            }
            .legend {
                margin-top: 20px;
                padding: 15px;
                background-color: var(--vscode-editor-inactiveSelectionBackground);
                border-radius: 4px;
            }
            .legend h3 {
                margin-top: 0;
            }
            .legend-item {
                display: inline-block;
                margin: 5px 10px;
                padding: 5px 10px;
                border-radius: 4px;
            }
            
            /* 高亮樣式 - 保留原始顏色的發光效果 */
            .highlighted rect,
            .highlighted polygon,
            .highlighted ellipse,
            .highlighted path {
                filter: drop-shadow(0 0 10px #FFC107) drop-shadow(0 0 20px #FFC107);
                animation: glow 1.5s infinite;
            }
            
            @keyframes glow {
                0% {
                    filter: drop-shadow(0 0 5px #FFC107) drop-shadow(0 0 10px #FFC107);
                }
                50% {
                    filter: drop-shadow(0 0 15px #FFC107) drop-shadow(0 0 30px #FFC107);
                }
                100% {
                    filter: drop-shadow(0 0 5px #FFC107) drop-shadow(0 0 10px #FFC107);
                }
            }
        </style>
    </head>
    <body>
        <h1>🔹 Python Code Flowchart</h1>
        
        <div class="controls">
            <button onclick="zoomIn()">🔍 Zoom In</button>
            <button onclick="zoomOut()">🔍 Zoom Out</button>
            <button onclick="resetZoom()">↺ Reset</button>
            <button onclick="exportSVG()">💾 Export SVG</button>
            <button onclick="clearHighlight()">✨ Clear Highlight</button>
        </div>
        
        <div id="mermaid-container">
            <div class="mermaid" id="flowchart">
                ${mermaidCode}
            </div>
        </div>
        
        <div class="legend">
            <h3>圖例說明 (ANSI/ISO標準):</h3>
            <span class="legend-item">🟢 Terminal (開始/結束) - 橢圓形</span>
            <span class="legend-item">📦 Process (處理) - 矩形</span>
            <span class="legend-item">💎 Decision (判斷) - 菱形</span>
            <span class="legend-item">🔄 Loop (迴圈) - 矩形/菱形</span>
            <span class="legend-item">📥 Input/Output (輸入/輸出) - 平行四邊形</span>
            <span class="legend-item">⚙️ Predefined Process (預定義處理) - 雙線矩形</span>
            <span class="legend-item">📦 Import (匯入模組)</span>
            <span class="legend-item">🏗️ Class Definition (類別定義)</span>
            <span class="legend-item">📞 Function Call (函式呼叫)</span>
            <h4>虛線箭頭 (- - ->) 加上 "calls" 表示函式呼叫關係。</h4>
            <h4>💡 點擊左側程式碼行，右側對應的流程圖節點會發光！</h4>
        </div>
        
        <script>
            const vscode = acquireVsCodeApi();
            let currentScale = 1;
            let currentHighlightedNodes = [];
            
            mermaid.initialize({ 
                startOnLoad: true,
                theme: 'default',
                flowchart: {
                    useMaxWidth: true,
                    htmlLabels: true,
                    curve: 'basis'
                },
                securityLevel: 'loose'
            });
            
            // 當 Mermaid 完成渲染後設置
            mermaid.init(undefined, document.querySelector('.mermaid')).then(() => {
                // 不需要設置點擊事件，因為現在是單向的（程式碼到流程圖）
            });
            
            function highlightNodes(nodeIds) {
                // 清除之前的高亮
                clearHighlight();
                
                console.log('Highlighting nodes:', nodeIds);
                
                // 高亮新的節點
                nodeIds.forEach(nodeId => {
                    // 更精確的查找：查找ID完全匹配或以nodeId-開頭的元素
                    const elements = document.querySelectorAll(\`.node\`);
                    elements.forEach(el => {
                        // 提取節點ID（格式通常是 flowchart-nodeX-XXX）
                        const elementId = el.id;
                        if (elementId) {
                            // 檢查是否包含目標節點ID
                            const idParts = elementId.split('-');
                            if (idParts.length >= 2) {
                                const extractedId = idParts[1];
                                // 完全匹配節點ID或特殊節點（如func_fib, Start, End）
                                if (extractedId === nodeId || 
                                    (nodeId.startsWith('func_') && elementId.includes(nodeId)) ||
                                    (nodeId === 'Start' && elementId.includes('Start')) ||
                                    (nodeId === 'End' && elementId.includes('End'))) {
                                    el.classList.add('highlighted');
                                    currentHighlightedNodes.push(el);
                                    console.log('Highlighted element:', elementId);
                                }
                            }
                        }
                    });
                });
                
                if (currentHighlightedNodes.length === 0) {
                    console.log('No nodes found to highlight');
                }
            }
            
            function clearHighlight() {
                // 移除所有高亮
                currentHighlightedNodes.forEach(el => {
                    el.classList.remove('highlighted');
                });
                currentHighlightedNodes = [];
            }
            
            // 監聽來自擴展的消息
            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.command) {
                    case 'highlightNodes':
                        highlightNodes(message.nodeIds);
                        break;
                    case 'clearHighlight':
                        clearHighlight();
                        break;
                }
            });
            
            function zoomIn() {
                currentScale += 0.1;
                document.querySelector('.mermaid').style.transform = \`scale(\${currentScale})\`;
            }
            
            function zoomOut() {
                currentScale = Math.max(0.5, currentScale - 0.1);
                document.querySelector('.mermaid').style.transform = \`scale(\${currentScale})\`;
            }
            
            function resetZoom() {
                currentScale = 1;
                document.querySelector('.mermaid').style.transform = 'scale(1)';
            }
            
            function exportSVG() {
                const svg = document.querySelector('.mermaid svg');
                const svgData = new XMLSerializer().serializeToString(svg);
                const blob = new Blob([svgData], { type: 'image/svg+xml' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'python-flowchart.svg';
                a.click();
            }
        </script>
    </body>
    </html>`;
}

export function deactivate() {
    if (currentPanel) {
        currentPanel.dispose();
    }
}