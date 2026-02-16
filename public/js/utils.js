/**
 * Shared utility functions.
 * @module utils
 */

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

/**
 * Determine whether a gap analysis result indicates "no gap" / already implemented.
 * @param {{ gap?: string }} gap
 * @returns {boolean}
 */
export function isNoGap(gap) {
    const text = (gap.gap || '').toLowerCase();
    const patterns = [
        'no gap', 'none', 'no changes needed', 'already implemented',
        'fully implemented', 'no action', 'requirement met', 'requirement is met',
        'no modification', 'no work needed', 'n/a', 'not applicable',
        'already exists', 'already in place', 'no additional', 'fully met',
        'compliant', 'complete as-is', 'nothing to', 'no missing',
    ];
    return patterns.some(p => text.includes(p));
}

/**
 * Format the current time as HH:MM:SS (24-hour).
 * @returns {string}
 */
export function formatTime() {
    return new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

/**
 * Async generator that parses an SSE (Server-Sent Events) ReadableStream
 * into typed event objects.
 * @param {ReadableStream} readableStream
 * @yields {{ event: string, data: * }}
 */
export async function* parseSSEStream(readableStream) {
    const reader = readableStream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const chunks = buffer.split('\n\n');
            buffer = chunks.pop(); // Keep incomplete chunk in buffer

            for (const chunk of chunks) {
                if (!chunk.trim()) continue;
                const lines = chunk.split('\n');
                let eventType = '';
                let eventData = '';
                for (const line of lines) {
                    if (line.startsWith('event: ')) eventType = line.slice(7);
                    if (line.startsWith('data: ')) eventData = line.slice(6);
                }
                if (eventType && eventData) {
                    yield { event: eventType, data: JSON.parse(eventData) };
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}
