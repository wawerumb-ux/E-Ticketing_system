/* Curated emoji avatar picker.
 *
 * For users who have no photo to upload: the disc falls back photo -> emoji ->
 * username monogram, and this builds the middle option.
 *
 * Hand-picked rather than generated, and shared by both portals so the two
 * lists can never drift apart. No remote picker library and nothing to fetch,
 * so it behaves identically offline (O1). The glyphs come from the reader's
 * own system emoji font, which is why the list sticks to common characters:
 * a rarer symbol risks a missing-glyph box on an older system (O2).
 */
(function () {
    'use strict';

    var GROUPS = [
        { label: 'Faces', items: ['\u{1F600}', '\u{1F604}', '\u{1F642}', '\u{1F605}', '\u{1F60E}', '\u{1F914}', '\u{1F634}', '\u{1F973}', '\u{1F622}', '\u{1F62D}'] },
        { label: 'Animals', items: ['\u{1F436}', '\u{1F431}', '\u{1F98A}', '\u{1F43C}', '\u{1F419}', '\u{1F989}', '\u{1F422}', '\u{1F984}', '\u{1F41D}', '\u{1F98B}'] },
        { label: 'Nature', items: ['\u{1F31E}', '\u{1F319}', '\u{2B50}', '\u{1F308}', '\u{1F335}', '\u{1F340}'] },
        { label: 'Food', items: ['\u{2615}', '\u{1F355}', '\u{1F354}', '\u{1F370}', '\u{1F34E}'] },
        { label: 'Work', items: ['\u{1F4BB}', '\u{1F5A5}\u{FE0F}', '\u{1F4F1}', '\u{1F527}', '\u{1F6E0}\u{FE0F}', '\u{2699}\u{FE0F}', '\u{1F3A7}', '\u{1F4CC}'] },
        { label: 'Symbols', items: ['\u{1F680}', '\u{1F4A1}', '\u{1F3C6}', '\u{1F3AF}', '\u{1F514}', '\u{1F9E9}'] }
    ];

    function render(container, onPick) {
        if (!container) return;
        container.textContent = '';
        GROUPS.forEach(function (group) {
            var wrap = document.createElement('div');
            wrap.className = 'emoji-group';

            var label = document.createElement('span');
            label.className = 'emoji-group-label';
            label.textContent = group.label;
            wrap.appendChild(label);

            var grid = document.createElement('div');
            grid.className = 'emoji-grid';
            group.items.forEach(function (emoji) {
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'emoji-choice';
                // textContent, never innerHTML: the glyph is data, and this
                // keeps it inert regardless of what the server stored.
                btn.textContent = emoji;
                // The glyph alone announces as an unhelpful character name, so
                // the choice gets a real label and the glyph stays silent.
                btn.setAttribute('aria-label', 'Use the ' + emoji + ' avatar');
                btn.addEventListener('click', function () {
                    onPick(emoji);
                });
                grid.appendChild(btn);
            });

            wrap.appendChild(grid);
            container.appendChild(wrap);
        });
    }

    window.EmojiPicker = { groups: GROUPS, render: render };
})();
