// Original, local illustrations: no image service receives customer identifiers.
const backgrounds = ['#FCE4E8', '#DDF1E9', '#E7E5FA', '#DFF0FA', '#FFF0D5', '#F3E5D9']
const animals = ['fox', 'cat', 'bear', 'rabbit', 'panda', 'dog'] as const

function identityHash(value: string) {
  let hash = 2166136261
  for (const character of value) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619)
  return hash >>> 0
}

export function Avatar({ name, seed }: { name: string; seed?: string }) {
  const hash = identityHash(seed ?? name.trim().normalize('NFC'))
  const animal = animals[hash % animals.length]
  const fur = animal === 'fox' ? '#DF8653' : animal === 'cat' ? '#899AB7' : animal === 'bear' ? '#B98A69' : animal === 'dog' ? '#C19B79' : '#FFF9F0'
  const ink = '#343341'
  return <span className="avatar" aria-hidden="true" style={{ background: 'transparent' }}>
    <svg viewBox="0 0 64 64" width="100%" height="100%" focusable="false" style={{ display: 'block', borderRadius: '50%' }}>
      <circle cx="32" cy="32" r="32" fill={backgrounds[(hash >>> 8) % backgrounds.length]} />
      {animal === 'rabbit' ? <><ellipse cx="23" cy="19" rx="7" ry="16" fill={fur} transform="rotate(-12 23 19)" /><ellipse cx="41" cy="19" rx="7" ry="16" fill={fur} transform="rotate(12 41 19)" /><path d="M22 9 25 27M42 9 39 27" stroke="#E7AFB5" strokeWidth="4" strokeLinecap="round" /></>
        : animal === 'cat' || animal === 'fox' ? <><path d="m12 31 2-21 18 14 18-14 2 21Z" fill={fur} /><path d="m17 16 1 12 8-4Zm30 0-1 12-8-4Z" fill={animal === 'fox' ? '#644847' : '#E5B6BD'} /></>
          : <><ellipse cx="16" cy={animal === 'dog' ? 34 : 22} rx="9" ry={animal === 'dog' ? 16 : 9} fill={animal === 'panda' ? ink : '#8D674E'} /><ellipse cx="48" cy={animal === 'dog' ? 34 : 22} rx="9" ry={animal === 'dog' ? 16 : 9} fill={animal === 'panda' ? ink : '#8D674E'} /></>}
      <ellipse cx="32" cy="38" rx="22" ry="21" fill={fur} />
      {animal === 'fox' && <path d="M11 32c7 0 16 5 21 13 5-8 14-13 21-13-1 16-10 27-21 27S12 48 11 32Z" fill="#FFF2DD" />}
      {animal === 'cat' && <path d="m26 19 3 9m6-9-1 8" stroke="#5D6C88" strokeWidth="3" strokeLinecap="round" />}
      {animal === 'panda' && <><ellipse cx="23" cy="35" rx="7" ry="9" fill={ink} transform="rotate(25 23 35)" /><ellipse cx="41" cy="35" rx="7" ry="9" fill={ink} transform="rotate(-25 41 35)" /></>}
      {(animal === 'bear' || animal === 'dog') && <ellipse cx="32" cy="46" rx="12" ry="10" fill="#F8E6D1" />}
      <circle cx="23" cy="35" r={animal === 'panda' ? 2 : 2.3} fill={animal === 'panda' ? '#FFF9F0' : ink} /><circle cx="41" cy="35" r={animal === 'panda' ? 2 : 2.3} fill={animal === 'panda' ? '#FFF9F0' : ink} />
      <ellipse cx="18" cy="43" rx="3.5" ry="2" fill="#E9A6A7" opacity=".7" /><ellipse cx="46" cy="43" rx="3.5" ry="2" fill="#E9A6A7" opacity=".7" />
      <path d="M28 42q4-3 8 0l-4 4Z" fill={animal === 'rabbit' ? '#D9929E' : ink} />
      <path d="M32 46v2m-5 0q2 4 5 0 3 4 5 0" fill="none" stroke={ink} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  </span>
}
