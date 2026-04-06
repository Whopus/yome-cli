import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { marked, type Token, type Tokens } from 'marked';

type Segment = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  dim?: boolean;
};

function parseInline(raw: string): Segment[] {
  const segs: Segment[] = [];
  const re = /(\*\*(.+?)\*\*)|(`([^`]+)`)|(\*(.+?)\*)|(~~(.+?)~~)|([^*`~]+)/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m[2]) segs.push({ text: m[2], bold: true });
    else if (m[4]) segs.push({ text: m[4], code: true });
    else if (m[6]) segs.push({ text: m[6], italic: true });
    else if (m[8]) segs.push({ text: m[8], dim: true }); // strikethrough → dim
    else if (m[9]) segs.push({ text: m[9] });
  }
  return segs.length > 0 ? segs : [{ text: raw }];
}

function InlineText({ text }: { text: string }): React.ReactElement {
  const segs = parseInline(text);
  return (
    <Text>
      {segs.map((s, i) => {
        if (s.code) return <Text key={i} color="cyan">{s.text}</Text>;
        if (s.bold) return <Text key={i} bold>{s.text}</Text>;
        if (s.italic) return <Text key={i} italic>{s.text}</Text>;
        if (s.dim) return <Text key={i} dimColor strikethrough>{s.text}</Text>;
        return <Text key={i}>{s.text}</Text>;
      })}
    </Text>
  );
}

function RenderToken({ token }: { token: Token }): React.ReactElement | null {
  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading;
      return <Text bold><InlineText text={t.text} /></Text>;
    }

    case 'paragraph': {
      const t = token as Tokens.Paragraph;
      return <InlineText text={t.text} />;
    }

    case 'text': {
      const t = token as Tokens.Text;
      return <InlineText text={t.text} />;
    }

    case 'code': {
      const t = token as Tokens.Code;
      return (
        <Box flexDirection="column" marginY={0}>
          {t.lang ? <Text dimColor>{'  '}{t.lang}</Text> : null}
          {t.text.split('\n').map((line, i) => (
            <Text key={i} color="gray">{'    '}{line}</Text>
          ))}
        </Box>
      );
    }

    case 'list': {
      const t = token as Tokens.List;
      return (
        <Box flexDirection="column">
          {t.items.map((item, i) => {
            const bullet = t.ordered ? `${i + 1}. ` : '• ';
            return (
              <Box key={i}>
                <Text dimColor>{'  '}{bullet}</Text>
                <Box flexShrink={1}>
                  <InlineText text={item.text} />
                </Box>
              </Box>
            );
          })}
        </Box>
      );
    }

    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      return (
        <Box flexDirection="column">
          {t.tokens.map((tk, i) => {
            const inner = tk.type === 'paragraph' ? (tk as Tokens.Paragraph).text : '';
            return (
              <Box key={i}>
                <Text dimColor>{'▎ '}</Text>
                <Text italic><InlineText text={inner} /></Text>
              </Box>
            );
          })}
        </Box>
      );
    }

    case 'hr':
      return <Text dimColor>{'─'.repeat(40)}</Text>;

    case 'space':
    case 'html':
      return null;

    default:
      if ('text' in token && typeof (token as any).text === 'string') {
        return <InlineText text={(token as any).text} />;
      }
      return null;
  }
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)```\s*$/);
  if (match) return match[1]!;
  return text;
}

export function Markdown({ children }: { children: string }): React.ReactElement {
  const tokens = useMemo(() => marked.lexer(stripMarkdownFence(children)), [children]);

  return (
    <Box flexDirection="column">
      {tokens.map((token, i) => {
        const node = <RenderToken token={token} />;
        if (token.type === 'space') return null;
        return <Box key={i}>{node}</Box>;
      })}
    </Box>
  );
}
