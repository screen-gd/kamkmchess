# Chess piece styles

Users can choose Merida, Cburnett, Firi or Kaneo in Appearance on the landing page or Settings in a match. Merida is the default. The choice is saved in browser storage and shared by the match board, promotion picker, position editor and landing preview.

| Style | Local directory | Artist | License |
| --- | --- | --- | --- |
| Merida | This directory, twelve individual SVGs | Armando Hernandez Marroquin | [GPL-2.0-or-later](../../../docs/licenses/Merida-GPL-2.0-or-later.txt) |
| Cburnett | `cburnett/` | Colin M. L. Burnett | [GPL-2.0-or-later](../../../docs/licenses/Cburnett-GPL-2.0-or-later.txt) |
| Firi | `firi/` | James Faure | [CC BY 4.0](../../../docs/licenses/Firi-CC-BY-4.0.txt) |
| Kaneo | `kaneo/` | Kadagaden | [CC BY 4.0](../../../docs/licenses/Kaneo-CC-BY-4.0.txt) |

Merida, Cburnett and Firi are copied from Lichess revision `3caccefdb06f4df57b207db8ea771e75698e6217`:

- [Merida source](https://github.com/lichess-org/lila/tree/3caccefdb06f4df57b207db8ea771e75698e6217/public/piece/merida).
- [Cburnett source](https://github.com/lichess-org/lila/tree/3caccefdb06f4df57b207db8ea771e75698e6217/public/piece/cburnett).
- [Firi source](https://github.com/lichess-org/lila/tree/3caccefdb06f4df57b207db8ea771e75698e6217/public/piece/firi), originally by [James Faure](https://github.com/jfaure/Firi-pieceset).
- [Lichess attribution](https://github.com/lichess-org/lila/blob/3caccefdb06f4df57b207db8ea771e75698e6217/COPYING.md), where Firi is listed as `public/piece/Firi`.

These 36 SVGs are unchanged. Only filenames are lowercased: upstream `wK.svg` becomes `wk.svg`, `bN.svg` becomes `bn.svg`, and likewise for all six roles in both colors.

Kaneo comes from [Kadagaden/chess-pieces](https://github.com/Kadagaden/chess-pieces/tree/b035b0cc6a68e9fb99c872c8fe073c3ae3eba8a0/chess_kaneo), revision `b035b0cc6a68e9fb99c872c8fe073c3ae3eba8a0`. It is inspired by the Neo pieces of chess.com. Its SVG artwork is unchanged. Filenames are lowercased, fixed `50mm` width and height attributes are removed for responsive sizing, and source and attribution comments are added.

All four sets' full license texts and attribution notices are included in generated distribution notices. The unreferenced `standard.svg` sprite predates these sets and retains its own embedded attribution.
