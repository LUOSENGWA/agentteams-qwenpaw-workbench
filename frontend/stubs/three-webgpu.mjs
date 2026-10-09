// three/webgpu 替身——插件走 WebGLRenderer 分支，WebGPU 分支从不
// 实例化（源码 0 命中）。真实模块 ~2.1MB raw 会被 3d-force-graph
// 的传递依赖静态 import 拖进单文件 bundle；alias 到此 stub 后
// 该死路径整体剔除（gzip 实测省 ~170KB）。若未来真要开 WebGPU，
// 删除 vite.config.ts 的 alias 即恢复真模块。
export class WebGPURenderer {
  constructor() {
    throw new Error(
      "WebGPURenderer is not bundled in this build (plugin uses WebGLRenderer); remove the three/webgpu alias in vite.config.ts to enable it",
    );
  }
}
