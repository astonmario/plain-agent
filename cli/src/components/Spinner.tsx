/**
 * 轻量转圈指示器（ink 6+ 移除了内置 Spinner，自行实现）
 * braille 点阵逐帧轮换，配合 setInterval 驱动
 */

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface SpinnerProps {
  color?: string;
  intervalMs?: number;
}

export default function Spinner({ color = '#F59E0B', intervalMs = 80 }: SpinnerProps) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return <Text color={color}>{FRAMES[frame]}</Text>;
}
