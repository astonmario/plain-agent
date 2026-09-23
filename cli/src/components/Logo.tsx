import React from 'react';
import { Box, Text } from 'ink';
import figlet from 'figlet';

const banner = figlet.textSync('PLAIN AGENT', {
  font: 'ANSI Shadow',
  horizontalLayout: 'default',
  verticalLayout: 'default',
});

export default function Logo() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="#5046e5" bold>
        {banner}
      </Text>
      <Box paddingLeft={12}>
        <Text color="#4ECDC4">{'</>  '}Plain Agent - Your AI Code Assistant</Text>
      </Box>
    </Box>
  );
}
