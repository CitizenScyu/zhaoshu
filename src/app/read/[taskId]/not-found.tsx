import Link from 'next/link';
import styles from '@/components/reader/reader.module.css';

export default function ReaderNotFound() {
  return (
    <main className={styles.screen}>
      <div className={styles.empty}>
        <span className="seal w-14 h-14 text-xl" aria-hidden="true">书径</span>
        <h1>找不到这张书页</h1>
        <p>阅读链接无效，请从书库重新打开。</p>
        <Link className={styles.back} href="/?tab=library">← 返回书库</Link>
      </div>
    </main>
  );
}
