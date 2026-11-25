export const LUDO_COLORS = [
  {
    id: 0,
    key: 'red',
    label: 'Red',
    hex: '#ff1744',
    dark: '#b71c1c',
    glow: '#ff5277',
    three: 0xff1744,
    startIndex: 0,
  },
  {
    id: 1,
    key: 'green',
    label: 'Green',
    hex: '#00e65b',
    dark: '#009e3d',
    glow: '#4dff91',
    three: 0x00e65b,
    startIndex: 13,
  },
  {
    id: 2,
    key: 'yellow',
    label: 'Yellow',
    hex: '#ffd600',
    dark: '#ff8f00',
    glow: '#fff176',
    three: 0xffd600,
    startIndex: 26,
  },
  {
    id: 3,
    key: 'blue',
    label: 'Blue',
    hex: '#0091ff',
    dark: '#0055cc',
    glow: '#40c4ff',
    three: 0x0091ff,
    startIndex: 39,
  },
];

// 52-tile clockwise outer track [row, col] on a 15x15 grid (0..14)
export const OUTER_PATH = [
  // 0..4 (Red start up)
  [13, 6], [12, 6], [11, 6], [10, 6], [9, 6],
  // 5..10 (Left arm bottom)
  [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  // 11 (Left middle)
  [7, 0],
  // 12..17 (Left arm top - 13 is Green start)
  [6, 0], [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],
  // 18..23 (Top arm left)
  [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6],
  // 24 (Top middle)
  [0, 7],
  // 25..30 (Top arm right - 26 is Yellow start)
  [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],
  // 31..36 (Right arm top)
  [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14],
  // 37 (Right middle)
  [7, 14],
  // 38..43 (Right arm bottom - 39 is Blue start)
  [8, 14], [8, 13], [8, 12], [8, 11], [8, 10], [8, 9],
  // 44..49 (Bottom arm right)
  [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8],
  // 50..51 (Bottom middle & corner)
  [14, 7], [14, 6],
];

// Safe tiles: 4 player start squares + 4 star shield squares
export const SAFE_INDICES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
export const STAR_ONLY_INDICES = new Set([8, 21, 34, 47]);

// 5-tile colored home-stretch columns for each seat (progress 51..55)
export const HOME_STRETCH = {
  0: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]], // Red
  1: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]], // Green
  2: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]], // Yellow
  3: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]], // Blue
};

// 4 Home Yard pad coordinates per seat (progress === -1)
export const HOME_YARDS = {
  0: [[10.4, 1.4], [10.4, 3.6], [12.6, 1.4], [12.6, 3.6]], // Red (Bottom-Left)
  1: [[1.4, 1.4], [1.4, 3.6], [3.6, 1.4], [3.6, 3.6]], // Green (Top-Left)
  2: [[1.4, 10.4], [1.4, 12.6], [3.6, 10.4], [3.6, 12.6]], // Yellow (Top-Right)
  3: [[10.4, 10.4], [10.4, 12.6], [12.6, 10.4], [12.6, 12.6]], // Blue (Bottom-Right)
};

// Center Home finish spots per seat (progress === 56)
export const FINISH_SPOTS = {
  0: [7.8, 7], // Red bottom triangle
  1: [7, 6.2], // Green left triangle
  2: [6.2, 7], // Yellow top triangle
  3: [7, 7.8], // Blue right triangle
};

export const TILE_SIZE = 0.62;

export function gridToWorld(row, col) {
  return {
    x: (col - 7) * TILE_SIZE,
    z: (row - 7) * TILE_SIZE,
  };
}

export function getPawnGridPos(seat, pawnIndex, progress) {
  if (progress < 0) {
    const [r, c] = HOME_YARDS[seat][pawnIndex];
    return { row: r, col: c, outerIdx: -1 };
  }
  if (progress <= 50) {
    const outerIdx = (LUDO_COLORS[seat].startIndex + progress) % 52;
    const [r, c] = OUTER_PATH[outerIdx];
    return { row: r, col: c, outerIdx };
  }
  if (progress <= 55) {
    const [r, c] = HOME_STRETCH[seat][progress - 51];
    return { row: r, col: c, outerIdx: -2 };
  }
  const [r, c] = FINISH_SPOTS[seat];
  return { row: r, col: c, outerIdx: -3 };
}
