// ==UserScript==
// @name         DeepSeek Chat 对话分组管理器 (React兼容版)
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  给 DeepSeek Chat 左侧栏添加对话分组/文件夹功能（保留原生菜单）
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

    function saveGroups() {
        GM_setValue(STORAGE_KEY, chatGroups);
        GM_setValue(STORAGE_CONFIG_KEY, groupConfig);
    }

    function getChatIdFromUrl(url) {
        const match = url.match(/\/chat\/s\/([a-f0-9-]+)/);
        return match ? match[1] : null;
    }

    // 在侧边栏中根据href查找真实的DOM元素
    function findChatElementByUrl(sidebar, url) {
        const links = sidebar.querySelectorAll('a[href*="/chat/s/"]');
        for (const link of links) {
            if (link.getAttribute('href') === url) {
                return link;
            }
        }
        // 模糊匹配
        const chatId = getChatIdFromUrl(url);
        if (chatId) {
            for (const link of links) {
                if (link.getAttribute('href') && link.getAttribute('href').includes(chatId)) {
                    return link;
                }
            }
        }
        return null;
    }

    // 在当前DOM中查找对话元素
    function findChatElementByChatId(sidebar, chatId) {
        const links = sidebar.querySelectorAll('a[href*="/chat/s/"]');
        for (const link of links) {
            if (link.getAttribute('href') && link.getAttribute('href').includes(chatId)) {
                return link;
            }
        }
        return null;
    }

    function getRandomColor(seed) {
        const colors = [
            '#4d6bfe', '#e4773d', '#22c55e', '#f59e0b',
            '#8b5cf6', '#ec4899', '#06b6d4', '#ef4444'
        ];
        let hash = 0;
        for (let i = 0; i < seed.length; i++) {
            hash = seed.charCodeAt(i) + ((hash << 5) - hash);
        }
        return colors[Math.abs(hash) % colors.length];
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
        for (const group in chatGroups) {
            chatGroups[group] = chatGroups[group].filter(id => id !== chatId);
        }
        if (!chatGroups[groupName].includes(chatId)) {
            chatGroups[groupName].push(chatId);
        }
        for (const group in chatGroups) {
            if (chatGroups[group].length === 0) {
                delete chatGroups[group];
            }
        }
        saveGroups();
        applyGroups();
    }

    function removeChatFromGroup(chatUrl) {
        const chatId = getChatIdFromUrl(chatUrl);
        if (!chatId) return;
        for (const group in chatGroups) {
            chatGroups[group] = chatGroups[group].filter(id => id !== chatId);
            if (chatGroups[group].length === 0) {
                delete chatGroups[group];
            }
        }
        saveGroups();
        applyGroups();
    }

    // 核心：不替换DOM，只移动元素
    function applyGroups() {
        const sidebar = getSidebar();
        if (!sidebar) {
            console.log('[GroupManager] Sidebar not found for applyGroups');
            return;
        }

        // 移除之前的分组容器
        const oldGroups = sidebar.querySelectorAll('[data-ds-group-container]');
        oldGroups.forEach(g => {
            // 将子元素移回父级
            while (g.firstChild) {
                if (g.firstChild.getAttribute && g.firstChild.getAttribute('data-ds-group-content')) {
                    // 展开内容区
                    while (g.firstChild.firstChild) {
                        g.parentNode.insertBefore(g.firstChild.firstChild, g);
                    }
                    g.parentNode.removeChild(g.firstChild);
                } else {
                    g.parentNode.insertBefore(g.firstChild, g);
                }
            }
            g.parentNode.removeChild(g);
        });

        const oldAddBtn = sidebar.querySelector('[data-ds-add-group-btn]');
        if (oldAddBtn) oldAddBtn.remove();

        const oldUngrouped = sidebar.querySelector('[data-ds-ungrouped-header]');
        if (oldUngrouped) oldUngrouped.remove();

        // 收集所有对话元素和它们的URL
        const chatLinks = [];
        sidebar.querySelectorAll('a[href*="/chat/s/"]').forEach(link => {
            chatLinks.push({
                element: link,
                url: link.getAttribute('href'),
                chatId: getChatIdFromUrl(link.getAttribute('href'))
            });
        });

        // 找出已分组和未分组
        const groupedChatIds = new Set();
        for (const group in chatGroups) {
            chatGroups[group].forEach(id => groupedChatIds.add(id));
        }

        // 先插入新建分组按钮（在第一个元素之前）
        const firstChild = sidebar.firstChild;
        const addBtn = createAddGroupButton();
        if (firstChild) {
            sidebar.insertBefore(addBtn, firstChild);
        } else {
            sidebar.appendChild(addBtn);
        }

        // 插入引用节点（在此之前的都是分组）
        const insertBeforeNode = addBtn.nextSibling;

        // 为每个分组创建容器并移动对话
        for (const groupName in chatGroups) {
            const groupContainer = createGroupContainerDOM(groupName);
            sidebar.insertBefore(groupContainer, insertBeforeNode);

            chatGroups[groupName].forEach(chatId => {
                const el = findChatElementByChatId(sidebar, chatId);
                if (el) {
                    const contentArea = groupContainer.querySelector('[data-ds-group-content]');
                    // 将元素包裹并移到分组中
                    const wrapper = createChatWrapper(el, groupName);
                    contentArea.appendChild(wrapper);
                }
            });

            // 如果分组为空，也显示（可能对话被删除了）
        }

        // 未分组header
        const ungroupedHeader = document.createElement('div');
        ungroupedHeader.setAttribute('data-ds-ungrouped-header', 'true');
        ungroupedHeader.style.cssText = 'padding: 8px 10px; font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-tertiary); user-select: none;';
        ungroupedHeader.textContent = '未分组';
        sidebar.insertBefore(ungroupedHeader, insertBeforeNode);

        // 给滚动容器添加底部间距
        addBottomPadding();
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
        // 阻止mousedown冒泡防止触发链接导航
        removeBtn.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            e.preventDefault();
        });

        wrapper.addEventListener('mouseenter', () => {
            removeBtn.style.opacity = '1';
        });
        wrapper.addEventListener('mouseleave', () => {
            removeBtn.style.opacity = '0';
        });

        wrapper.appendChild(removeBtn);
        return wrapper;
    }

    function createGroupContainerDOM(groupName) {
        const container = document.createElement('div');
        container.setAttribute('data-ds-group-container', groupName);
        container.style.cssText = 'margin-top: 0;';

        const config = groupConfig[groupName] || {};
        const isCollapsed = config.collapsed || false;
        const color = config.color || getRandomColor(groupName);

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

        header.innerHTML = `
            <span class="group-toggle-area" style="display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0;">
                <span class="group-toggle-icon" style="font-size: 10px; transition: transform 0.2s; display: inline-block; flex-shrink: 0;">${isCollapsed ? '▶' : '▼'}</span>
                <span style="color: ${color}; flex-shrink: 0;">📁</span>
                <span class="group-name-text" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${groupName}</span>
                <span class="group-count" style="font-size: 11px; color: var(--dsw-alias-label-tertiary); flex-shrink: 0;">(${chatGroups[groupName] ? chatGroups[groupName].length : 0})</span>
            </span>
            <span class="group-actions" style="display: flex; gap: 4px; opacity: 0; transition: opacity 0.2s; flex-shrink: 0;">
                <button class="group-rename-btn" title="重命名" style="background: none; border: none; color: var(--dsw-alias-label-tertiary); cursor: pointer; padding: 2px 4px; font-size: 12px;">✏️</button>
                <button class="group-color-btn" title="换颜色" style="background: none; border: none; color: var(--dsw-alias-label-tertiary); cursor: pointer; padding: 2px 4px; font-size: 12px;">🎨</button>
                <button class="group-delete-btn" title="删除分组" style="background: none; border: none; color: var(--dsw-alias-label-tertiary); cursor: pointer; padding: 2px 4px; font-size: 12px;">🗑️</button>
            </span>
        `;

        header.addEventListener('mouseenter', () => {
            header.querySelector('.group-actions').style.opacity = '1';
        });
        header.addEventListener('mouseleave', () => {
            header.querySelector('.group-actions').style.opacity = '0';
        });

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

        // 换颜色
        header.querySelector('.group-color-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const colorPicker = document.createElement('input');
            colorPicker.type = 'color';
            colorPicker.value = color;
            colorPicker.style.cssText = 'position: absolute; opacity: 0; width: 0; height: 0;';
            document.body.appendChild(colorPicker);
            colorPicker.click();
            colorPicker.addEventListener('change', () => {
                if (!groupConfig[groupName]) groupConfig[groupName] = {};
                groupConfig[groupName].color = colorPicker.value;
                saveGroups();
                applyGroups();
                if (document.body.contains(colorPicker)) document.body.removeChild(colorPicker);
            });
            colorPicker.addEventListener('blur', () => {
                if (document.body.contains(colorPicker)) document.body.removeChild(colorPicker);
            });
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
        btn.innerHTML = '<span style="font-size: 14px;">📁</span><span>新建分组</span>';

        btn.addEventListener('mouseenter', () => {
            btn.style.background = 'var(--dsw-alias-interactive-bg-hover-accent)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.background = 'var(--dsw-alias-interactive-bg-hover)';
        });

        btn.addEventListener('click', () => {
            const groupName = prompt('请输入分组名称:');
            if (groupName && !chatGroups[groupName]) {
                if (!groupConfig[groupName]) groupConfig[groupName] = {};
                groupConfig[groupName].color = getRandomColor(groupName);
                chatGroups[groupName] = [];
                saveGroups();
                applyGroups();
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

    // 增强对话链接（拖拽 + 右键菜单）
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

                if (Object.keys(chatGroups).length > 0 && existingGroup) {
                    // 已有分隔符
                } else if (Object.keys(chatGroups).length === 0) {
                    // 没有分组时提示
                    addItem('📁 新建分组...', () => {
                        const groupName = prompt('请输入新分组名称:');
                        if (groupName && !chatGroups[groupName]) {
                            if (!groupConfig[groupName]) groupConfig[groupName] = {};
                            groupConfig[groupName].color = getRandomColor(groupName);
                            addChatToGroup(groupName, href);
                        }
                    });
                }

                addItem('🆕 新建分组并添加', () => {
                    const groupName = prompt('请输入新分组名称:');
                    if (groupName && !chatGroups[groupName]) {
                        if (!groupConfig[groupName]) groupConfig[groupName] = {};
                        groupConfig[groupName].color = getRandomColor(groupName);
                        addChatToGroup(groupName, href);
                    }
                });

                document.body.appendChild(menu);

                const closeMenu = (ev) => {
                    if (!menu.contains(ev.target)) {
                        menu.remove();
                        document.removeEventListener('click', closeMenu);
                        document.removeEventListener('contextmenu', closeMenu);
                    }
                };
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
        return null;
    }

    // 防抖定时器
    let debounceTimer = null;
    let enhanceTimer = null;

    function observeDOM() {
        const observer = new MutationObserver(() => {
            // 增强新链接
            clearTimeout(enhanceTimer);
            enhanceTimer = setTimeout(enhanceAllChatLinks, 300);

            // 检测是否需要重新应用分组
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const sidebar = getSidebar();
                if (sidebar) {
                    // 检查是否有对话不在分组容器中
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
        console.log('[GroupManager v2] Initializing...');

        let attempts = 0;
        const maxAttempts = 40;

        const checkReady = setInterval(() => {
            attempts++;
            const sidebar = getSidebar();
            if (sidebar && sidebar.querySelectorAll('a[href*="/chat/s/"]').length > 0) {
                clearInterval(checkReady);
                console.log('[GroupManager v2] Sidebar found, applying groups...');
                enhanceAllChatLinks();
                applyGroups();
                observeDOM();
                isInitialized = true;
                console.log('[GroupManager v2] Initialized!');
            } else if (attempts >= maxAttempts) {
                clearInterval(checkReady);
                console.log('[GroupManager v2] Timeout, will retry...');
                // 最后尝试
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