import { describe, expect, it } from 'vitest'
import { LANGUAGE_IDS } from '../src/shared/syntax-language'
import { textOfTokens, type TokenKind, type TokenLine } from '../src/shared/syntax-tokens'
import { highlightLines } from '../src/renderer/highlight/engine'

const kinds = (line: TokenLine): (TokenKind | null)[] => line.map((t) => t.kind)
const kindOf = (line: TokenLine, word: string): TokenKind | null | undefined => line.find((t) => t.text.includes(word))?.kind

describe('highlightLines: a whole text, cut into lines', () => {
  it('colours a multi-line block comment on every line of it', async () => {
    const lines = ['const a = 1 /* the start', 'still the comment', 'the end */ const b = 2']
    const out = (await highlightLines('typescript', lines))!
    expect(out.map(textOfTokens)).toEqual(lines)
    expect(kindOf(out[0], 'const')).toBe('kw')
    expect(kinds(out[1])).toEqual(['cm'])
    expect(kindOf(out[2], 'the end')).toBe('cm')
    expect(kindOf(out[2], 'const')).toBe('kw')
  })

  it('shows why a line alone is wrong: the same middle line has no comment colour without its neighbours', async () => {
    const alone = (await highlightLines('typescript', ['still the comment']))!
    expect(kinds(alone[0])).not.toEqual(['cm'])
  })

  it('colours a multi-line template string on every line of it', async () => {
    const lines = ['const s = `one', 'two ${x} and', 'three`', 'const n = 3']
    const out = (await highlightLines('typescript', lines))!
    expect(out.map(textOfTokens)).toEqual(lines)
    expect(out[1][0]).toEqual({ text: 'two ', kind: 'str' })
    expect(kindOf(out[2], 'three')).toBe('str')
    expect(kindOf(out[3], 'const')).toBe('kw')
  })

  it('colours a Python docstring on every line of it', async () => {
    const lines = ['def f():', '    """First line', '    import os', '    """', '    return 1']
    const out = (await highlightLines('python', lines))!
    expect(out.map(textOfTokens)).toEqual(lines)
    expect(kindOf(out[2], 'import')).toBe('str')
    expect(kindOf(out[4], 'return')).toBe('kw')
  })

  it('keeps the text of hostile code as text', async () => {
    const lines = ['const x = "<script>alert(1)</script>"; // <img src=x onerror=alert(2)>']
    const out = (await highlightLines('javascript', lines))!
    expect(textOfTokens(out[0])).toBe(lines[0])
    expect(out[0].every((t) => typeof t.text === 'string')).toBe(true)
  })

  it('colours the tags of a TSX file through the xml grammar', async () => {
    const out = (await highlightLines('typescript', ['const a = <Button size="s">Go</Button>']))!
    expect(out[0].some((t) => t.kind === 'tg')).toBe(true)
  })

  it('colours a directive and an annotation as special code', async () => {
    const c = (await highlightLines('c', ['#include <stdio.h>']))!
    expect(c[0][0].kind).toBe('mt')
    const java = (await highlightLines('java', ['@Override', 'void f() {}']))!
    expect(java[0][0].kind).toBe('mt')
  })

  it('returns null for a language it does not know', async () => {
    expect(await highlightLines('klingon', ['qapla'])).toBeNull()
  })

  it('handles an empty text and empty lines', async () => {
    expect(await highlightLines('typescript', [''])).toEqual([[]])
    const out = (await highlightLines('typescript', ['a', '', 'b']))!
    expect(out.map(textOfTokens)).toEqual(['a', '', 'b'])
  })
})

const SAMPLES: Record<string, string[]> = {
  bash: ['#!/bin/sh', 'set -e # stop', 'echo "$HOME"'],
  c: ['#include <stdio.h>', 'int main(void) { return 0; }'],
  cmake: ['# build', 'add_executable(app main.c)'],
  cpp: ['#include <vector>', 'template <class T> class A { public: T x; };'],
  csharp: ['using System;', 'public class A { public int X { get; set; } }'],
  css: ['/* c */', '.a { color: red; }'],
  dart: ['void main() { print("x"); }'],
  dockerfile: ['FROM node:22', 'RUN npm ci'],
  dos: ['@echo off', 'set A=1'],
  elixir: ['defmodule A do', '  def f, do: 1', 'end'],
  fsharp: ['let x = 1', 'printfn "%d" x'],
  go: ['package main', 'func main() { println("x") }'],
  gradle: ['plugins { id "java" }', 'dependencies { implementation "a:b:1" }'],
  graphql: ['type A { id: ID! }'],
  groovy: ['def x = "a" // c', 'pipeline { agent any }'],
  haskell: ['main :: IO ()', 'main = putStrLn "x"'],
  hcl: ['# a comment', 'resource "aws_s3_bucket" "b" {', '  bucket = "x-${var.name}"', '  count = 2', '}', 'output "o" { value = length(var.l) }'],
  ini: ['[section]', 'key = "value" ; c'],
  java: ['public class A { private int x = 1; }'],
  javascript: ['const a = (x) => x + 1 // c'],
  json: ['{ "a": [1, true, null], "b": "c" }'],
  kotlin: ['fun main() { val x = 1 }'],
  less: ['@c: red;', '.a { .b(); color: @c; }'],
  lua: ['local x = 1 -- c'],
  makefile: ['all: build', '\t@echo done'],
  markdown: ['# Title', '- item with `code`', '```ts', 'let x', '```'],
  nginx: ['server { listen 80; }'],
  objectivec: ['@interface A : NSObject', '@end'],
  perl: ['my $x = 1; # c'],
  php: ['<?php', 'function f($a) { return $a; }'],
  powershell: ['Get-ChildItem -Path . | Where-Object { $_.Length -gt 1 }'],
  properties: ['a.b=c', '# c'],
  protobuf: ['message A { int32 id = 1; }'],
  python: ['def f(x):', '    return x + 1  # c'],
  r: ['x <- c(1, 2)'],
  ruby: ['def f(x)', '  x + 1', 'end'],
  rust: ['fn main() { let x: i32 = 1; }'],
  scala: ['object A { def f = 1 }'],
  scss: ['$c: red;', '.a { &:hover { color: $c; } }'],
  sql: ['SELECT a, COUNT(*) FROM t WHERE b = 1 GROUP BY a; -- c'],
  swift: ['func f() -> Int { return 1 }'],
  typescript: ['export interface A { x: number }', 'const a: A = { x: 1 }'],
  vbnet: ['Public Class A', 'End Class'],
  xml: ['<?xml version="1.0"?>', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup /></Project>'],
  yaml: ['a:', '  - b: 1', '  - "c" # d']
}

describe('every grammar', () => {
  it('has a sample in this test', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...LANGUAGE_IDS])
  })
  it.each(Object.entries(SAMPLES))('%s loads, keeps the text and gives at least one colour', async (id, lines) => {
    const out = await highlightLines(id, lines)
    expect(out, id).not.toBeNull()
    expect(out!.map(textOfTokens)).toEqual(lines)
    expect(
      out!.flat().some((t) => t.kind !== null),
      id
    ).toBe(true)
  })
})
