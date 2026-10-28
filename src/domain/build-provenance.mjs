// 构建来源运行时读取（L0-02）
//
// 两种运行模式：
//   - 源码模式（node server.mjs）：没有构建常量，返回 null，上层降级为"来源未知"。
//   - bundle / EXE 模式：构建脚本会把 `__LILYMAP_BUILD__` 用 esbuild `define`
//     替换成真实对象字面量，这里直接读到。
//
// 为什么用 `typeof` 而不是 try/catch：
//   未定义标识符在严格模式下直接抛 ReferenceError，try/catch 能捕获，
//   但 `typeof 未定义标识符` 是唯一**永不抛错**的检测方式，最稳。
//   esbuild 的 define 只在标识符作为**表达式**出现时替换，
//   因此 `typeof __LILYMAP_BUILD__` 在 bundle 里会被替换成 `typeof {...}`
//   或直接内联，源码模式下保持原样（返回 'undefined'）。

export function readEmbeddedBuildInfo() {
  if (typeof __LILYMAP_BUILD__ === 'undefined') return null;
  // eslint-disable-next-line no-undef
  return __LILYMAP_BUILD__ || null;
}
