import { describe, expect, it } from 'vitest'
import { clampTreeWidth, nextTreeWidth, parseStoredTreeWidth, treeWidthFromPointer } from '../src/shared/tree-width'

describe('clampTreeWidth', () => {
  it.each([
    [199, 1000, 200],
    [200, 1000, 200],
    [201, 1000, 201],
    [599, 1000, 599],
    [600, 1000, 600],
    [601, 1000, 600],
    [-50, 1000, 200],
    [5000, 1000, 600],
    [350.4, 1000, 350],
    [350.6, 1000, 351],
    [250, 1001, 250],
    [700, 1001, 600],
    [250, 300, 200],
    [200, 300, 200],
    [201, 300, 200],
    [320, 0, 200]
  ])('clamps %d px in an area of %d px to %d px', (px, area, expected) => {
    // Arrange

    // Act
    const result = clampTreeWidth(px, area)

    // Assert
    expect(result).toBe(expected)
  })
})

describe('treeWidthFromPointer', () => {
  it.each([
    [505, 100, 1000, 400],
    [637, 212, 1100, 420],
    [304, 100, 1000, 200],
    [305, 100, 1000, 200],
    [306, 100, 1000, 201],
    [704, 100, 1000, 599],
    [705, 100, 1000, 600],
    [706, 100, 1000, 600],
    [10, 100, 1000, 200],
    [5000, 100, 1000, 600],
    [405.4, 100, 1000, 300],
    [400, 100, 300, 200]
  ])('turns the pointer at x %d with the area at left %d and width %d into %d px', (clientX, areaLeft, areaWidth, expected) => {
    // Arrange

    // Act
    const result = treeWidthFromPointer(clientX, areaLeft, areaWidth)

    // Assert
    expect(result).toBe(expected)
  })
})

describe('nextTreeWidth', () => {
  it.each([
    [320, 'ArrowRight', 1000, 344],
    [320, 'ArrowLeft', 1000, 296],
    [417, 'ArrowRight', 1300, 441],
    [417, 'ArrowLeft', 1300, 393],
    [224, 'ArrowLeft', 1000, 200],
    [225, 'ArrowLeft', 1000, 201],
    [226, 'ArrowLeft', 1000, 202],
    [200, 'ArrowLeft', 1000, 200],
    [576, 'ArrowRight', 1000, 600],
    [577, 'ArrowRight', 1000, 600],
    [575, 'ArrowRight', 1000, 599],
    [600, 'ArrowRight', 1000, 600],
    [320, 'ArrowRight', 300, 200],
    [200, 'ArrowRight', 300, 200]
  ] as const)('moves %d px by key %s in an area of %d px to %d px', (current, key, area, expected) => {
    // Arrange

    // Act
    const result = nextTreeWidth(current, key, area)

    // Assert
    expect(result).toBe(expected)
  })
})

describe('parseStoredTreeWidth', () => {
  it.each([
    [null, 320],
    ['', 320],
    ['not json', 320],
    ['"400"', 320],
    ['true', 320],
    ['null', 320],
    ['{"a":1}', 320],
    ['[400]', 320],
    ['NaN', 320],
    ['1e999', 320],
    ['-1e999', 320],
    ['199', 320],
    ['0', 320],
    ['-300', 320],
    ['200', 200],
    ['201', 201],
    ['437', 437],
    ['1500', 1500],
    ['437.4', 437],
    ['437.6', 438]
  ])('reads the stored value %s as %d px', (raw, expected) => {
    // Arrange

    // Act
    const result = parseStoredTreeWidth(raw)

    // Assert
    expect(result).toBe(expected)
  })
})
