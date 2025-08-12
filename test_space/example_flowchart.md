# 我的流程图

下面是一个简单的 Mermaid 图表示例：

```mermaid
flowchart TD
  A[开始] --> B{条件判断}
  B -- yes --> C[执行操作1]
  B -- no  --> D[执行操作2]
  C --> E[结束]
  D --> E
