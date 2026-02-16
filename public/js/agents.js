/**
 * Agent identity constants for the multi-agent pipeline UI.
 * @module agents
 */

/** @type {Record<string, { name: string, role: string, letter: string, class: string, logo?: string }>} */
export const AGENTS = {
    extractor: {
        name: 'WorkIQ',
        role: 'Requirements Agent',
        letter: 'W',
        class: 'extractor',
        logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0c/Microsoft_Office_logo_%282013%E2%80%932019%29.svg/120px-Microsoft_Office_logo_%282013%E2%80%932019%29.svg.png',
    },
    analyzer: {
        name: 'Analyzer',
        role: 'Gap Analysis Agent',
        letter: 'A',
        class: 'analyzer',
    },
    builder: {
        name: 'Builder',
        role: 'Build Agent',
        letter: 'B',
        class: 'builder',
    },
    deployer: {
        name: 'Deployer',
        role: 'Deploy Agent',
        letter: 'D',
        class: 'deployer',
        logo: 'https://cdn.worldvectorlogo.com/logos/azure-1.svg',
    },
    validator: {
        name: 'Validator',
        role: 'QA Agent',
        letter: 'V',
        class: 'validator',
    },
};
