#!/bin/bash
# 批量修复 App.tsx 中的类型错误

cd /d/code/plain-agent/web/src

# 1. 修复可选方法调用
sed -i '196s/client.getConfig()/client.getConfig?.()/' App.tsx
sed -i '205s/client.onEvent(/client.onEvent?.(/' App.tsx
sed -i '211s/client.getHistoryUsage()/client.getHistoryUsage?.()/' App.tsx

# 2. 修复 getMessages 调用（移除 boolean 参数，改为传递 sessionId）
sed -i '229s/client.getMessages(true)/client.getMessages(sessionId, true)/' App.tsx

# 3. 修复 createSession 返回值
sed -i '238s/session.id/session.sessionId/' App.tsx

# 4. 修复 switchSession 调用
sed -i '269s/client.switchSession(/client.switchSession?.(/' App.tsx

# 5. 修复不存在的方法名
sed -i 's/client.submit(/client.submitTask(currentSessionId, /g' App.tsx
sed -i 's/client.stop(/client.stopTask(currentSessionId/g' App.tsx
sed -i 's/client.compressHistory(/client.compactHistory(currentSessionId, /g' App.tsx

echo "App.tsx 批量修复完成"
