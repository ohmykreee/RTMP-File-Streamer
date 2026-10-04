此文件夹保存程序运行时的全部状态，不会随版本更新被覆盖：

  settings.json   ffmpeg 路径与当前会话设置
  playlist.json   播放列表（下次启动自动恢复）
  presets.json    你保存的预设
  Logs/           运行日志留存
  Cache/          Chromium/Electron 的缓存与日志

因为状态就在程序目录内，整个程序文件夹可以直接复制或移动到 U 盘使用。
删除本文件夹等同于恢复出厂设置。

---------------------------------------------------------------------------

This folder holds everything the application persists at run time. A version
update does not overwrite it:

  settings.json   ffmpeg path and the current session settings
  playlist.json   the playlist (restored on the next launch)
  presets.json    the presets you saved
  Logs/           the persisted run logs
  Cache/          Chromium/Electron caches and logs

Because the state lives inside the application folder, the whole folder can be
copied or moved to a USB stick and used as it is.
Deleting this folder is the same as resetting the application to its defaults.

---------------------------------------------------------------------------

このフォルダーには、アプリが実行時に保存するすべての状態が入っています。
バージョン更新で上書きされることはありません：

  settings.json   ffmpeg のパスと現在のセッション設定
  playlist.json   プレイリスト（次回起動時に復元されます）
  presets.json    保存したプリセット
  Logs/           実行ログの保存先
  Cache/          Chromium/Electron のキャッシュとログ

状態がアプリのフォルダー内にあるため、フォルダーごと USB メモリにコピー
または移動して、そのまま使えます。
このフォルダーを削除することは、アプリを初期状態に戻すことと同じです。
