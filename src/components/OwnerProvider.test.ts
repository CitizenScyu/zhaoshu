import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OwnerProvider, useOwner } from './OwnerProvider';

// 本文件选择 node 环境下的 renderToStaticMarkup，验证首个渲染快照与上下文契约。
// SSR 不执行 effect，因此这里不覆盖挂载后的会话订阅和异步身份切换。
// 需要 DOM 交互时，仓库支持以文件注释选择 jsdom 环境（见 vitest.config.ts）。

function renderOwner(probe: (value: ReturnType<typeof useOwner>) => void): void {
  let seen: ReturnType<typeof useOwner> | undefined;
  function Probe() {
    seen = useOwner();
    return null;
  }
  renderToStaticMarkup(createElement(OwnerProvider, null, createElement(Probe)));
  if (!seen) throw new Error('probe 未被渲染，useOwner 没有返回上下文');
  probe(seen);
}

describe('OwnerProvider 上下文契约', () => {
  // 回归护栏：把抛错改成 `return null`（或返回默认值）之后，任何在 Provider 之外误用
  // useOwner 的组件都会静默拿到「未登录」而不是当场炸掉。本用例必须因此失败。
  it('在 Provider 之外调用 useOwner 当场抛错，不返还静默的默认值', () => {
    function Orphan() {
      useOwner();
      return null;
    }
    expect(() => renderToStaticMarkup(createElement(Orphan)))
      .toThrowError('useOwner must be used within OwnerProvider');
  });

  // 回归护栏：会话探测还没回来时，ready 必须为 false、user 必须为 null。
  // ready 一旦提前为 true，ReaderGate 会把未登录用户当成已登录直接进阅读页。
  it('首个渲染快照：会话未定时既不假装就绪，也不给任何身份', () => {
    renderOwner((owner) => {
      expect(owner.status).toBe('loading');
      expect(owner.ready).toBe(false);
      expect(owner.user).toBeNull();
      expect(owner.authMethod).toBeNull();
      expect(owner.expired).toBe(false);
      expect(owner.sessionOnly).toBe(false);
      expect(owner.sessionId).toBe(0);
      // 部署开关未知时按「未启用账号模式」处理，不抢先渲染某一个登录入口。
      expect(owner.accountsEnabled).toBe(false);
    });
  });

  // 权限只能来自 user 的 canX 三个布尔位；没有身份时三个都必须拒绝。
  it('没有身份时三项权限一律拒绝', () => {
    renderOwner((owner) => {
      expect(owner.permissions).toEqual({ find: false, read: false, download: false });
      expect(owner.can('find')).toBe(false);
      expect(owner.can('read')).toBe(false);
      expect(owner.can('download')).toBe(false);
    });
  });

  // 消费组件一律直接调用这些字段；少一个就会在运行期炸在别人的组件里。
  it('对外暴露的操作面齐全且可调用', () => {
    renderOwner((owner) => {
      for (const key of ['setSessionOnly', 'submitToken', 'login', 'logout', 'refresh', 'apiFetch', 'can', 'isCurrentSession'] as const) {
        expect(typeof owner[key], `${key} 必须是函数`).toBe('function');
      }
    });
  });

  it('Provider 真的把 children 渲染出来', () => {
    const html = renderToStaticMarkup(
      createElement(OwnerProvider, null, createElement('span', null, '书径正文')),
    );
    expect(html).toBe('<span>书径正文</span>');
  });
});
