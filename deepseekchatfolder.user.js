// ==UserScript==
// @name         DeepSeek Chat 对话分组管理器 (React兼容版)
// @namespace    http://tampermonkey.net/
// @version      2.3
// @description  给 DeepSeek Chat 左侧栏添加对话分组/文件夹功能，彻底修复刷新与字体颜色继承问题
// @author       You
// @match        https://chat.deepseek.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function() {
    'use strict';

    const STORAGE_KEY = 'ds_chat_groups_v3';
    const STORAGE_CONFIG_KEY = 'ds_chat_group_config_v3';

    let chatGroups = GM_getValue(STORAGE_KEY, {});
    let groupConfig = GM_getValue(STORAGE_CONFIG_KEY, {});
    let isInitialized = false;

    // 添加互斥锁，防止 MutationObserver 和我们的 DOM 操作死循环
    let isApplyingDOM = false;

    function saveGroups() {
        GM_setValue(STORAGE_KEY, chatGroups);
        GM_setValue(STORAGE_CONFIG_KEY, groupConfig);
    }

    function getChatIdFromUrl(url) {
        const match = url.match(/\/chat\/s\/([a-f0-9-]+)/);
        return match ? match[1] : null;
    }

    // 在当前DOM中查找对话元素
    function findChatElementByChatId(parent, chatId) {
        const links = parent.querySelectorAll('a[href*="/chat/s/"]');
        for (const link of links) {
            if (link.getAttribute('href') && link.getAttribute('href').includes(chatId)) {
                return link;
            }
        }
        return null;
    }

    // 获取对话分组名
    function getChatGroup(chatUrl) {
        const chatId = getChatIdFromUrl(chatUrl);
        if (!chatId) return null;
        for (const group in chatGroups) {
            if (chatGroups[group].includes(chatId)) {
                return group;
            }
        }
        return null;
    }

    function addChatToGroup(groupName, chatUrl) {
        const chatId = getChatIdFromUrl(chatUrl);
        if (!chatId) return;
        if (!chatGroups[groupName]) {
            chatGroups[groupName] = [];
        }
        // 先从所有组中移除该对话
        for (const group in chatGroups) {
            chatGroups[group] = chatGroups[group].filter(id => id !== chatId);
        }
        // 加入目标组
        if (!chatGroups[groupName].includes(chatId)) {
            chatGroups[groupName].push(chatId);
        }
        
        saveGroups();
        applyGroups(); // 立即同步UI
    }

    function removeChatFromGroup(chatUrl) {
        const chatId = getChatIdFromUrl(chatUrl);
        if (!chatId) return;
        for (const group in chatGroups) {
            chatGroups[group] = chatGroups[group].filter(id => id !== chatId);
        }
        
        saveGroups();
        applyGroups(); // 立即同步UI
    }

    // 核心重构：安全彻底地还原DOM并重新分组
    function applyGroups() {
        if (isApplyingDOM) return;
        isApplyingDOM = true; // 上锁

        const sidebar = getSidebar();
        if (!sidebar) {
            isApplyingDOM = false;
            return;
        }

        // 【关键修复】获取真正的链接父级容器，而不是外层 scrollbar，避免移出分组后跑到列表外不可见
        let linksParent = sidebar;
        const firstLink = sidebar.querySelector('a[href*="/chat/s/"]');
        if (firstLink) {
            linksParent = firstLink.parentNode;
        }

        // --- 1. 彻底清理环境：将所有 a 标签提取回原生侧边栏，并销毁遗留的 wrapper ---
        const wrappers = linksParent.querySelectorAll('[data-ds-grouped-chat]');
        wrappers.forEach(w => {
            const aTag = w.querySelector('a[href*="/chat/s/"]');
            if (aTag) {
                // 安全移出：放回真正的父容器中
                const container = w.closest('[data-ds-group-container]');
                if (container) {
                    linksParent.insertBefore(aTag, container);
                } else {
                    linksParent.insertBefore(aTag, w);
                }
            }
            w.remove(); // 彻底销毁 wrapper，防止幽灵节点污染 DOM
        });

        // --- 2. 销毁所有自定义的分组容器和组件 ---
        const customElements = linksParent.querySelectorAll(
            '[data-ds-group-container], [data-ds-add-group-btn], [data-ds-ungrouped-header]'
        );
        customElements.forEach(el => el.remove());

        // 收集当前所有的对话元素（刚刚被放回来的，或者新生成的）
        const allLinks = Array.from(linksParent.querySelectorAll('a[href*="/chat/s/"]'));

        // --- 3. 重建分组 UI ---
        // 插入新建分组按钮（在最顶部）
        const addBtn = createAddGroupButton();
        if (linksParent.firstChild) {
            linksParent.insertBefore(addBtn, linksParent.firstChild);
        } else {
            linksParent.appendChild(addBtn);
        }

        const insertBeforeNode = addBtn.nextSibling;

        // 为每个分组创建容器并移动对话
        for (const groupName in chatGroups) {
            const groupContainer = createGroupContainerDOM(groupName);
            linksParent.insertBefore(groupContainer, insertBeforeNode);

            chatGroups[groupName].forEach(chatId => {
                const el = findChatElementByChatId(linksParent, chatId);
                if (el) {
                    const contentArea = groupContainer.querySelector('[data-ds-group-content]');
                    // 将原生元素包裹一层并放入分组内容区
                    const wrapper = createChatWrapper(el, groupName);
                    contentArea.appendChild(wrapper);
                }
            });
        }

        // --- 4. 处理未分组区域 ---
        const ungroupedHeader = document.createElement('div');
        ungroupedHeader.setAttribute('data-ds-ungrouped-header', 'true');
        ungroupedHeader.style.cssText = 'padding: 8px 10px; font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-tertiary); user-select: none;';
        ungroupedHeader.textContent = '未分组';
        linksParent.insertBefore(ungroupedHeader, insertBeforeNode);

        // 把仍然游离的未分组链接整理一下（排到列表最后）
        allLinks.forEach(link => {
            if (!link.closest('[data-ds-group-container]')) {
                linksParent.appendChild(link); // Append 到父容器末尾即可无缝显示
            }
        });

        // 解决内容遮挡问题
        addBottomPadding();

        // DOM 更新完毕，稍微延迟后解锁，防止后续原生渲染抢占
        setTimeout(() => { isApplyingDOM = false; }, 50);
    }

    function createChatWrapper(originalElement, groupName) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'position: relative;';
        wrapper.setAttribute('data-ds-grouped-chat', groupName);

        // 移动原始元素（保留所有事件监听器）
        wrapper.appendChild(originalElement);

        // 移出按钮
        const removeBtn = document.createElement('span');
        removeBtn.textContent = '✕';
        removeBtn.style.cssText = `
            position: absolute;
            right: 8px;
            top: 50%;
            transform: translateY(-50%);
            cursor: pointer;
            opacity: 0;
            transition: opacity 0.2s;
            color: var(--dsw-alias-label-tertiary);
            font-size: 12px;
            padding: 2px 6px;
            z-index: 5;
            pointer-events: auto;
        `;
        removeBtn.title = `从 "${groupName}" 移出`;
        
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const href = originalElement.getAttribute('href');
            removeChatFromGroup(href);
        });
        
        // 阻止mousedown冒泡防止误触跳转
        removeBtn.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            e.preventDefault();
        });

        wrapper.addEventListener('mouseenter', () => removeBtn.style.opacity = '1');
        wrapper.addEventListener('mouseleave', () => removeBtn.style.opacity = '0');

        wrapper.appendChild(removeBtn);
        return wrapper;
    }

    function createGroupContainerDOM(groupName) {
        const container = document.createElement('div');
        container.setAttribute('data-ds-group-container', groupName);
        container.style.cssText = 'margin-top: 0;';

        const config = groupConfig[groupName] || {};
        const isCollapsed = config.collapsed || false;

        const header = document.createElement('div');
        header.style.cssText = `
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: space-between;
            user-select: none;
            padding: 8px 10px;
            border-radius: 8px;
            margin-bottom: 2px;
            position: sticky;
            top: 0;
            z-index: 10;
            background: var(--dsw-specific-sidebar-fill);
        `;

        // 【关键修复】明确给文字加上 color: var(--dsw-alias-label-primary) 阻止 body 紫色的污染
        header.innerHTML = `
            <span class="group-toggle-area" style="display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0;">
                <span class="group-toggle-icon" style="font-size: 10px; transition: transform 0.2s; display: inline-block; flex-shrink: 0; color: var(--dsw-alias-label-tertiary);">${isCollapsed ? '▶' : '▼'}</span>
                <span style="flex-shrink: 0; color: var(--dsw-alias-label-primary);">📁</span>
                <span class="group-name-text" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary);">${groupName}</span>
                <span class="group-count" style="font-size: 11px; color: var(--dsw-alias-label-tertiary); flex-shrink: 0;">(${chatGroups[groupName] ? chatGroups[groupName].length : 0})</span>
            </span>
            <span class="group-actions" style="display: flex; gap: 4px; opacity: 0; transition: opacity 0.2s; flex-shrink: 0;">
                <button class="group-rename-btn" title="重命名" style="background: none; border: none; color: var(--dsw-alias-label-tertiary); cursor: pointer; padding: 2px 4px; font-size: 12px;">✏️</button>
                <button class="group-delete-btn" title="删除分组" style="background: none; border: none; color: var(--dsw-alias-label-tertiary); cursor: pointer; padding: 2px 4px; font-size: 12px;">🗑️</button>
            </span>
        `;

        header.addEventListener('mouseenter', () => header.querySelector('.group-actions').style.opacity = '1');
        header.addEventListener('mouseleave', () => header.querySelector('.group-actions').style.opacity = '0');

        // 折叠/展开
        header.querySelector('.group-toggle-area').addEventListener('click', (e) => {
            if (e.target.closest('.group-actions')) return;
            const content = container.querySelector('[data-ds-group-content]');
            const icon = header.querySelector('.group-toggle-icon');
            if (content.style.display === 'none') {
                content.style.display = 'block';
                icon.textContent = '▼';
                if (groupConfig[groupName]) groupConfig[groupName].collapsed = false;
            } else {
                content.style.display = 'none';
                icon.textContent = '▶';
                if (groupConfig[groupName]) groupConfig[groupName].collapsed = true;
            }
            saveGroups();
        });

        // 重命名
        header.querySelector('.group-rename-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const newName = prompt('输入新名称:', groupName);
            if (newName && newName !== groupName && !chatGroups[newName]) {
                chatGroups[newName] = chatGroups[groupName];
                if (groupConfig[groupName]) {
                    groupConfig[newName] = groupConfig[groupName];
                }
                delete chatGroups[groupName];
                delete groupConfig[groupName];
                saveGroups();
                applyGroups();
            }
        });

        // 删除分组
        header.querySelector('.group-delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(`确定要删除分组 "${groupName}" 吗？\n对话不会被删除，只会移出分组。`)) {
                delete chatGroups[groupName];
                delete groupConfig[groupName];
                saveGroups();
                applyGroups();
            }
        });

        const content = document.createElement('div');
        content.setAttribute('data-ds-group-content', 'true');
        content.style.display = isCollapsed ? 'none' : 'block';

        // 拖放支持
        content.addEventListener('dragover', (e) => {
            e.preventDefault();
            content.style.background = 'var(--dsw-alias-interactive-bg-hover)';
            content.style.borderRadius = '8px';
        });
        content.addEventListener('dragleave', () => {
            content.style.background = '';
        });
        content.addEventListener('drop', (e) => {
            e.preventDefault();
            content.style.background = '';
            const chatUrl = e.dataTransfer.getData('text/chat-url');
            if (chatUrl) {
                addChatToGroup(groupName, chatUrl);
            }
        });

        container.appendChild(header);
        container.appendChild(content);
        return container;
    }

    function createAddGroupButton() {
        const wrapper = document.createElement('div');
        wrapper.setAttribute('data-ds-add-group-btn', 'true');
        wrapper.style.cssText = `
            padding: 4px 6px 12px 6px;
            border-bottom: 1px solid var(--dsw-alias-border-l1);
            margin: 0 2px 8px 2px;
        `;

        const btn = document.createElement('div');
        btn.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            cursor: pointer;
            color: var(--dsw-alias-label-secondary);
            background: var(--dsw-alias-interactive-bg-hover);
            border-radius: 10px;
            padding: 8px 12px;
            font-size: 13px;
            font-weight: 500;
            transition: background 0.2s;
            user-select: none;
        `;
        btn.innerHTML = '<span style="font-size: 14px; color: var(--dsw-alias-label-primary);">📁</span><span>新建分组</span>';

        btn.addEventListener('mouseenter', () => btn.style.background = 'var(--dsw-alias-interactive-bg-hover-accent)');
        btn.addEventListener('mouseleave', () => btn.style.background = 'var(--dsw-alias-interactive-bg-hover)');

        btn.addEventListener('click', () => {
            const groupName = prompt('请输入分组名称:');
            if (groupName && !chatGroups[groupName]) {
                if (!groupConfig[groupName]) groupConfig[groupName] = {};
                chatGroups[groupName] = [];
                saveGroups();
                applyGroups(); // 新建后立即重新渲染
            } else if (chatGroups[groupName]) {
                alert('该分组已存在！');
            }
        });

        wrapper.appendChild(btn);
        return wrapper;
    }

    function addBottomPadding() {
        const scrollContainers = document.querySelectorAll('._3586175, [class*="_3586175"], ._6d215eb, [class*="_6d215eb"]');
        scrollContainers.forEach(el => {
            el.style.paddingBottom = '70px';
        });
    }

    // 全局缓存当前的关闭菜单函数，防止内存泄漏
    let currentCloseMenu = null;

    function enhanceAllChatLinks() {
        const sidebar = getSidebar();
        if (!sidebar) return;

        const links = sidebar.querySelectorAll('a[href*="/chat/s/"]');
        links.forEach(link => {
            if (link.getAttribute('data-group-enhanced')) return;
            link.setAttribute('data-group-enhanced', 'true');
            link.setAttribute('draggable', 'true');

            const href = link.getAttribute('href');

            link.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/chat-url', href);
                link.style.opacity = '0.5';
            });
            link.addEventListener('dragend', () => {
                link.style.opacity = '1';
            });

            // 右键菜单
            link.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();

                const existingGroup = getChatGroup(href);
                const oldMenu = document.querySelector('.ds-group-context-menu');
                if (oldMenu) oldMenu.remove();

                if (currentCloseMenu) {
                    document.removeEventListener('click', currentCloseMenu);
                    document.removeEventListener('contextmenu', currentCloseMenu);
                    currentCloseMenu = null;
                }

                const menu = document.createElement('div');
                menu.className = 'ds-group-context-menu';
                menu.style.cssText = `
                    position: fixed;
                    left: ${e.clientX}px;
                    top: ${e.clientY}px;
                    background: var(--dsw-specific-menu);
                    border: 1px solid var(--dsw-alias-border-inverted);
                    border-radius: 12px;
                    box-shadow: var(--dsw-shadow-lv3);
                    z-index: 10001;
                    padding: 4px;
                    min-width: 200px;
                    font-size: 13px;
                `;

                const addItem = (label, action) => {
                    const item = document.createElement('div');
                    item.textContent = label;
                    item.style.cssText = `
                        padding: 8px 12px;
                        cursor: pointer;
                        border-radius: 8px;
                        white-space: nowrap;
                        color: var(--dsw-alias-label-primary);
                    `;
                    item.addEventListener('mouseenter', () => item.style.background = 'var(--dsw-alias-interactive-bg-hover)');
                    item.addEventListener('mouseleave', () => item.style.background = '');
                    item.addEventListener('click', () => {
                        action();
                        menu.remove();
                    });
                    menu.appendChild(item);
                };

                const addSeparator = () => {
                    const sep = document.createElement('div');
                    sep.style.cssText = 'height: 1px; background: var(--dsw-alias-border-l2); margin: 4px 0;';
                    menu.appendChild(sep);
                };

                if (existingGroup) {
                    addItem(`📤 从 "${existingGroup}" 移出`, () => removeChatFromGroup(href));
                    addSeparator();
                }

                for (const groupName in chatGroups) {
                    if (groupName !== existingGroup) {
                        addItem(`📁 移动到 "${groupName}"`, () => addChatToGroup(groupName, href));
                    }
                }

                if (Object.keys(chatGroups).length === 0) {
                    addItem('📁 新建分组...', () => {
                        const groupName = prompt('请输入新分组名称:');
                        if (groupName && !chatGroups[groupName]) {
                            if (!groupConfig[groupName]) groupConfig[groupName] = {};
                            addChatToGroup(groupName, href);
                        }
                    });
                }

                addItem('🆕 新建分组并添加', () => {
                    const groupName = prompt('请输入新分组名称:');
                    if (groupName && !chatGroups[groupName]) {
                        if (!groupConfig[groupName]) groupConfig[groupName] = {};
                        addChatToGroup(groupName, href);
                    }
                });

                document.body.appendChild(menu);

                const closeMenu = (ev) => {
                    if (!menu.contains(ev.target)) {
                        menu.remove();
                        document.removeEventListener('click', closeMenu);
                        document.removeEventListener('contextmenu', closeMenu);
                        currentCloseMenu = null;
                    }
                };
                currentCloseMenu = closeMenu; 
                
                setTimeout(() => {
                    document.addEventListener('click', closeMenu);
                    document.addEventListener('contextmenu', closeMenu);
                }, 0);
            });
        });
    }

    function getSidebar() {
        const selectors = [
            '._6d215eb',
            '._77cdc67',
            '[class*="_6d215eb"]',
            '[class*="_77cdc67"]',
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.querySelectorAll('a[href*="/chat/s/"]').length > 0) {
                return el;
            }
        }
        
        // 兜底方案
        const fallbackLink = document.querySelector('a[href*="/chat/s/"]');
        if (fallbackLink) {
            const container = fallbackLink.closest('div[style*="overflow"]') || fallbackLink.parentElement.parentElement;
            if (container) return container;
        }
        return null;
    }

    // 防抖定时器
    let debounceTimer = null;
    let enhanceTimer = null;

    function observeDOM() {
        const observer = new MutationObserver(() => {
            if (isApplyingDOM) return;

            clearTimeout(enhanceTimer);
            enhanceTimer = setTimeout(enhanceAllChatLinks, 300);

            // 被动监测到原生的新对话节点加载时，自动将其整合进分组
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const sidebar = getSidebar();
                if (sidebar) {
                    const groupedWrappers = sidebar.querySelectorAll('[data-ds-grouped-chat]');
                    const allLinks = sidebar.querySelectorAll('a[href*="/chat/s/"]');
                    const groupedLinks = new Set();
                    groupedWrappers.forEach(w => {
                        const link = w.querySelector('a[href*="/chat/s/"]');
                        if (link) groupedLinks.add(link);
                    });

                    let needsRefresh = false;
                    allLinks.forEach(link => {
                        if (!groupedLinks.has(link) && !link.closest('[data-ds-group-container]')) {
                            const href = link.getAttribute('href');
                            // 如果页面上出现了属于某个分组的链接，但它目前游离在外，触发刷新
                            if (getChatGroup(href)) {
                                needsRefresh = true;
                            }
                        }
                    });

                    if (needsRefresh) {
                        applyGroups();
                    }
                }
            }, 800);
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    function init() {
        console.log('[GroupManager v2.3] Initializing...');
        let attempts = 0;
        const maxAttempts = 40;

        const checkReady = setInterval(() => {
            attempts++;
            const sidebar = getSidebar();
            if (sidebar && sidebar.querySelectorAll('a[href*="/chat/s/"]').length > 0) {
                clearInterval(checkReady);
                console.log('[GroupManager v2.3] Sidebar found, applying groups...');
                enhanceAllChatLinks();
                applyGroups();
                observeDOM();
                isInitialized = true;
                console.log('[GroupManager v2.3] Initialized!');
            } else if (attempts >= maxAttempts) {
                clearInterval(checkReady);
                setTimeout(() => {
                    enhanceAllChatLinks();
                    applyGroups();
                    observeDOM();
                    isInitialized = true;
                }, 3000);
            }
        }, 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();