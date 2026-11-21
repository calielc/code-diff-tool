// A small grammar for HCL, the language of Terraform files. highlight.js has none, so the app defines its own.

import type { HLJSApi, Language, Mode } from 'highlight.js'

export default function hcl(hljs: HLJSApi): Language {
  const keywords = {
    keyword: 'resource data variable output module provider locals terraform backend required_providers dynamic for in if else lifecycle provisioner',
    literal: 'true false null',
    built_in: 'each count path self var local'
  }
  const inner: Mode = { className: 'string', begin: /"/, end: /"/, contains: [hljs.BACKSLASH_ESCAPE] }
  const interpolation: Mode = { className: 'subst', begin: /\$\{/, end: /\}/, keywords, contains: [inner, hljs.NUMBER_MODE] }
  const string: Mode = { className: 'string', begin: /"/, end: /"/, contains: [hljs.BACKSLASH_ESCAPE, interpolation] }
  return {
    name: 'HCL',
    aliases: ['terraform', 'tf'],
    keywords,
    contains: [
      hljs.HASH_COMMENT_MODE,
      hljs.C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE,
      string,
      hljs.NUMBER_MODE,
      { className: 'title.function', begin: /[A-Za-z_]\w*(?=\()/, relevance: 0 },
      { className: 'attr', begin: /[A-Za-z_][\w-]*(?=\s*=[^=])/, relevance: 0 }
    ]
  }
}
