/** Only the explicitly built, isolated inspector fixture mode disables writes. */
export function isReadOnlyDemo() { return import.meta.env.MODE === 'inspector-demo' }
