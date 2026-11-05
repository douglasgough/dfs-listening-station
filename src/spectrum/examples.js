/* Bundled sampled-spectrum examples (copied verbatim from the prototype), their decoder, and the example layers. */
import { slugify } from './parse.js';

export const EXAMPLE_LINES = [
  "mgp124|Allende|CV3|350|5|0.063946|0.120461|AABHDlGEIaKELLMjN7PLQJRPSnTlUjVYWfXTXuX3YIYaY1ZYZyaEaebLbucIcacjc9dpeeflgahYhyiNiWieiWiWiei5jTjukIkjksksk9lGlPlYlpmEmVmemnnCncn/oaoso9pPpYpYpyqEqeqnqwqwqwq5rTrcrcrTrKrKrKrKrKq5qnqEpppPo9o9o9o0osoaoIn3nunununununun3n/oIoIn/n/n/oRojo0o9o9pGpGpPpYpgpYpPpYpppypppgpYpYpgpgpypyp7p7p7qEqNqVqeqeqeqVqnqwrCrTrlrur/sIsRsjsrtGtYtyt7uEuVueununununununuwvBvKvTvcvlvuv/wIwIwIwRwjw0w9w9w9xGxGw9w9xXxyyEyVyeywzBzTzczlzTy5ynyVyEx7x7yVywzKzczlz20R0r09091G1P1X1g1p1y1p1y2E2M2n2n2w25253B3B3T3T3T3K2525253K3T3c3l3l3l3t3t3t3l3t323/3/3/3t3l3l3t323/4I4R4R4I323t3l3l3t3232323232323t3t323/3/3/4I4I4R4a4i4i4a4a4I4R4R4R3/3t3l3c3l3l3t324I4R4a4i4a4R4I3/3/4I4a4i4a4I3/3/4I4I4I3/4I4R4a4R4a4i4a4R4I4I4I4R4a4R4R4I4R4a4i4r4r4r4i4i4a4a4i405G494940404949494949495G5G5G5G5X5p575757576E6E6E6M6V6V6M6M6V6e6w657B7K7T7T7c7l7t7t728I8R8a8a8i8080808089899G9O9O9O9G9G9X9g9g9g9p979797+D+M+e+n+4/B/K/l/2/////2/T+e979p9y",
  "mgp094|Murchison|CM2|350|5|0.03999|0.059653|AAA/CXEtHEKNMXOhQsTPWkZhc2fBglhwivlGmenpocp0r+uIwFxEyDy10B1M294i5t6s6s7F648Q8d82829c9o91+b+b91828d8Q737e7e6s6T5h4u4I3v291y0az00B0N0N0B0n1A1l1A0n0B0B0B0N0Bz0zbzbz0z0zozOzOzOzCy1ycycycyQyQyQyQx3xRw4w4wrwFvHuhuhu6u6uVuVuVuVt7titJs8s8s8sws8tvuhuuuuu6uut7s8swtJtiuIt7uVtvtWsXrlrMq/rMrMrlrxsXswswswsjsjs8tJtWtWtJs8sws8tJtWtJs8s8s8sws8tWtitWtWtWtiuIvTwfwrwrwrwfwFwFwSwrw4xRxexqxqx3yDx3xexRxeyQzOz00N0B0B0Bz0zbzbz00n1Z1+1+2L2x3v383W2x2x3W384V4u4u383j385U566T6G6T6f7F7F6s6s7r8d8d737r738q9o+B+B+B+n/Z/m/N/A+b+B+B+n/Z///////z/A+n+b+O+n/A/z///Z+0+O+O+b/A/Z/m/N+b+B+B+b+n+b+n+0/Z/Z/Z/N+n+O+O+n/A+0/A/A/N/N/N/N/A/A/A/N/N/A+n+b+n+b+O+B+O+0+0+0+n+b+b/A/A+0+b+b9o8d7r8E829P828q829D9D8q8d8E7r7F7R7R7F64647R7e7e7F647F646s6f6T6T6T6T6T5t5U5U5t6G6G5t5U5h5U5H4u474u4V4I4V4i4i4V4I383W292k2k293W3K2Y2L2k3K3W3W3j3j3W2x2k293W3K2k1+1l1+2k3K3W3j3K2x2Y2k2x2x2Y2Y2x3K3W3W3j3v4I4u5U5U5H474i475U5t5U4u4i4i",
  "mgp078|Orgueil|CI|350|5|0.01864|0.05328|AABMCMDFESF4GxHqI9KdMDNPOIPIPuQ7SNUAVmWyXZX/YlZSZ4aebXcXc9d3edfcgDhPi1kUlhm0oAo5pmp5qyrZr/sstSt4t4t4t4t4t4t4uevEvxvxvxvxvxwEwXwqwqwqw9xQxjyKywzdzdzdzdzw0W081P1P1P1P1P1P1P1P1P1P1P1P1P1P1P1P1P1P1P1P1P080p0p081P1P1P1P1P1i1i2I2I2i2I2i213I3I3I3I3I3u4V4747474747474747474o475O57576O6h606060607H7a7t7t7t8A8T8m8m8m8m8m8m8m8m8m8m8m8m8m9A9T9m9m9m9m9m9m9m9m9m9m9m9m95+M+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+z/G/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/Z/G+z+f+z+z+z+z+z+z+f+f+f+f+z+z+z+f+f+f+f+f+f+f+f+f+f+f+f+z+z+z+f+f+f+f+f+f+f+f+z+z/G+z+z+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f+f/G/Z/s/Z/s/s///s/s/Z/Z/Z/Z/Z/Z/Z/G+z+f+M959m9m9T9A8m8T8A7a7H6060606060606060606h6O5757575757575757575757575757575757575757575757575n474V4B4B4B",
  "mgp084|Alais|CI|350|5|0.01981|0.067793|AAAAAXA7BjCMC1DTD2EkFfGlHmIaI9JyKyL4MtNQNtN5OFOWO6PdP0QXQ6RpSeTYUNUwVTV8W3XrYsZJZmZ4aPabaybVbnb4cEcKcbcnczc5dEdKdQdQdWdid5eFdtdidneWe0fFe/e5e5fRfcfofifof0gAgAgAgFgjhAhRhRhMhMhAhGhMhdhph1h1h1iGiYidiSidi1jSjYjSjMjGjMjSjYjej1kBkNkSkYkYkSkYkYkekkk2lHlNlTlelwmCmTmrmwm2m8nInTnrn3nrn3n8oUogolologoxpDpOpapxp9p3pspsp3qDqVqsq4q9q4q9rJrmsEsbshsytEtQtQtQtWtWtbttuKuiututututuzu5u/vQvWvivov5v/wXwuxLxXxXxdxdxjxpx0x6x6yGyMySyGyGySyjyvy6zGzMzjz1z70B0B0M0S0q1B1T1e1e1e1w182f2w3I3N3N3C2w2w3I3f324O4l4r4x495I5a5m5g5U5a536U6g6g6g6g6s697V7g7y747+8D8V8h8h8h8h8s8s8y9E9V9b9V9V9h9++W+c+c+c+c+h+h+z/F/c/i/i/t/z/5/////5/o/Q+5+Q9+9h9E8P7V6s6U5m494Z4I38324C4U4f495U5m536a697m8D8s849E9K9V9h9t9z9z94+K+W+c+c+Q+W+c+n+n+n+h+W+Q+Q+W+Q+W+c+c+c+W+K9t9V9V9t949++E+E9+9z9n9t9z9+949z9z9t9h9b9b9n9b9V9E84848+848s8h8b8V8D74747y7m7V7J696y6m6O6D5r5g5O5C4x4Z4I3Z2w2N181w1q1e1N010k0S0BzjzMzMzGzAy1yvyjydySyAxpxdxL",
  "mgn003|Abee|E4|350|5|0.06579|0.130989|AABCBbCVDGDPDKD0EAERElEuE2FLFfGEGNGVGqHCHTHbIFINIJIFIZIqI+I2IyI2IyI6I+JLJwKFKdK2KyKyK2LoLgJkKiMJK/MmLbL0L0LXLwLwMFMVMuM6NoN4OiOuPTPwQJQaQyQyQ/RgR1SFSeSeSqTDTPTYTUTUT5UWUeUiUzUmUmUuUqUmUiUmUeUaUaUWUmUqUzUzU/U/U7UzU7VHVsWWWmXLXkX9YJYOYWYqY7ZDZDZUZtZ1Z1Z1aFaWaSaWama3a/bQbQbIbgbpb5bxcacrcvc7c/dDdIdYdgdpd5d9eKenevfIfYfxf1fxgSgjgngvg7hEhchYhYhlhlhthtiKh+iGiKiWifiaiOifinirjAi3i3i3jIjUjYjUjljlkCkCkjknkfkKjtjMjIjAi8jMjUjhj6kbk3k3lMldlhltlpltlxl+mKmfm4mzm8nAnEnEnIndn+n+oOoCoOoKoTpApEpApQpdpZplp2p6qTqOqTqbqXqbqwrErMrRrhr+ryrprysKsXsTsfsfsjs4s8tRtVtRtZtZtltutltptyt+uCuTuXufuju8vEvAvNvZvdvqvuvyv+wLwPwTwjwfwbwfw8xAxRxVxJxExZxdxhxuxuxqxyyCybyPyfyjysysy4zAzJzFzJzJzNzNzFzNzqzuz60Lz+0X0P0f0o0o0s0w00041F1A1J081R1V1V1Z1q1u2D16122T2X2g2k2X2o2w2w3F3i3i3V3Z3y364D4L4T4L3/4P4c4g4k404440445R5e5u5e525u6L6o6T6w6569657B7e7a7e7q7q7q7m7/8L8k8w8o8w899F9W9W9a9a9m9u9q9y+L+c+1+9/J/7///3+99u9i",
  "mgn033|Allegan|H5|350|5|0.151|0.259|AAByEcHaKFMJOhPaQAQ5RfSqUJVVXHXHYAY5ZeaXbQb2dCdoehfHftglhLiEiXiqkJkvl7m0n/olo4pLpxqXqqqqrQrQrQr2r2sJsvsvtVtot7uzvZwSwlxexeyEy9zQz20v1U1n162N2g2g2g2g2g2g2N2N1n1U0czjyqxewSugtCrjpxoSmOj2iEfHdVbQY5XtUvTQSEPtOONoMvL2KYJyJfJMI5I5I5I5JfJfJyKYKYK9LjMJNCO0PaQARMSETjUcVVWhXHYmZxaXa9cJd7ehfHf/hLi9jjkJkJlCl7m0n/olpxqXqqrjsctCtouOuzvZvsv/wlxLxexxxxyXyXy9zQzjz2z20c0c1C1U1n162N2N3G3G3Z3Z3/4S4l5L5e6E6X6q7Q7j728J8J8J8u9B9U9n9n96+z/G/Z/Z/s///////////////////////s/s/Z/Z/G/G/G/G+g+N+N969B9B8c8J8J7j696X5x5e5L4l4l3s3Z3G2N1U0v0c0JzjyqyXxxxew4vsvZuzuOtVtCsvr2rjrQqXqEpepLoSn/nsnZm0mOmOlVlVlCkvkckcj2jjjQiqiqiqiEhehehehehLg4g4g4gSgSgSgSgSgSgSglglgSgSglglglglg4g4hLhLhLhehxhxhxhxiXiqiqi9i9jjj2j2kckvlClVlVlVl7mhmhm0nGnGnZn/oSolpLpepxqEqEqXq9q9rjr2sJsJscsvsvtVtCtot7t7uOuguzvGvGvGvsvsv/wSwSwSwSwlw4w4xexexexxxxxxyXyXyqyqy9y9zjzQzQzjzj0J0c0v0v0v1U1U1U1n16162N2N2z2z2z3G3G3G3Z3/3/3/3/3s3s3s3s",
  "mgp073|Angra_dos_Reis|ACANOM|350|5|0.045899|0.248905|AAAFALAQAVAgAgAqA1A6A6BABFBFBFBFBAA6A6A6A1AwAwAwAwAwAwA1A6A6BABFBFBKBaBvB/CPCZCpCpCvC0C5DEDJDZDeDpDzEDEOETEeEuFDFYFoF4GIGdGyHHHhH8IWIsJBJbJ2KQKwLALaLvMKMkM/NUNeNpNuN5N5N+ODODODN5N0NuNuNuNuNuNkNeNZNUNPNJM/M5MvMfMaMKMEL6LvLlLaLVLKLKLFLALALALAK6K1K1K6LALKLVLVLVLaLaLlLlLvL1MEMUMkM5NENUNkN0N+OJOTOjOzPIPdP4QNQdQyRCRXRsR8SXSxTGTbTrUGUbU7VVV1WKWkW/XfX5YZYzZTZ4adbCbicMcxdWd7ebfAflgKg0hUh+ipjYj9kolSl8mhnBnhoBogpFplqFqlrKrvsUs5teuDuovCviwCwnxBxcxxyGybywzLzr0F0V0l061K1f102J2f2u2+3O3e3p354I4O4Y4o445N5Y5i5t53596H6N6S6d6i6n6s6y63687H7M7R7R7R7R7R7R7R7R7R7R7R7R7R7R7R7R7R7R7M7H7H7H7C686863636y6s6i6d6d6X6S6S6N6H6C5959535y5o5i5Y5N5I49444z4t4o4e4Y4O4I3+3z3p3e3Z3O3O3E2+2u2p2f2f2Z2P2J2E101q1f1a1K0/01010q0l0a0V0Q0F0F0A0A0Az7z7z1z1z1z1zwzwzrzrzrzwzwz1z1z1zwzwz10A0F0K0K0Q0V0g0g0l0q0q0v010/1F1K1P1f1q10162E2P2Z2p2+3O3Z3e3u3+4O4j4z5D5S5o596H6X6n687M7h728M8m9B9Q9b9m97+V+q/A/V/l/6////////",
  "mgp009|Casey_County|IA|350|5|0.1145|0.335|AAAlA4BmCLCwDDDfDxEgEpFOFqGGGiG+HjH/IbJAJSJuKKKTKdKvK4LLLLLeLwLwL5MMMVMxNENWNpN7OFOOOOOXOhOqPGPPPiP0QQQQQQQZQjQ1Q+RIRRRaRaRaR2R/SJSbS3TKTKTTTcTvTvT4ULULUUUnUwVCVMVeVeVxV6WDWNWNWNWfWfWyWyW7W7XEXOXXXgXqXzX8YPYYYYYrYrY9Y9ZGZGZZZiZsZ1aHajaja2bIbIbbbkbkb3cAcAcTcvc4dBdddmdmd5d5eLeLeLeeeeenexe6fDfMfffyf7gNgNgXgggggzg8hFhFhYhqhqh9iPiPiii1i1i+i+jHjQjajjjsjsj2j/kRkRkbkkk3lAlJlJlclclllumBmBmBmTmTmTmmmvm5nLnUnUnUnUnLnLnUnenennnwn6oMoVoooxoxpEpNpNpWpWpgppp8qFqFqOqXqqqzqzrGrPrPrPriririr0r0r+sHsQsZsZsjsss1s1s/tItatktkttttt2uJuSuSububululu3u3vKvKvKvTvmvvv4wCwLwLwUwdwdwnwnwww5xDxMxVxVxoxoxxx6yNyNyNyNyfyyyyyyyyy7y7zOzXzXzgzqzqzqzqzqzqz8z80G0G0G0Y0Y0Y001H1Q1Q1Q1Z1i1s111+1+2R2R2a2j2t2t222/3J3b3b3k3u4A4A4K4K4T4c4c4v445B5B5B5B5U5d5m5w6C6C6C6V6V6e6x6x66667N7N7N7N7f7f7o7o7o7o7y778E8E8E8X8X8p8p8z889F9P9P9P9h9h90909099+G+G+Q+Q+Q+Q+Z+i+r+r+r+1+1+1+1++/H/R/R/a/a/j/s/s///2/////////s/R/R",
];

export function decodeExample(line) {
  const [id, name, type, w0, dw, mn, mx, data] = line.split('|');
  const B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const x = [], y = [];
  for (let i = 0, k = 0; i < data.length; i += 2, k++) {
    const q = (B.indexOf(data[i]) << 6) | B.indexOf(data[i + 1]);
    x.push(+w0 + +dw * k); y.push(+mn + q / 4095 * (+mx - +mn));
  }
  return { name: name.replace(/_/g, ' ') + ' (' + type + ')', x, y, x0: x[0], x1: x[x.length - 1], unit: 'nm' };
}

const lineLayer = (id, name, type, rows) => ({
  id, name, kind: 'lines', quantity: 'intensity', axis: { unit: 'nm', x0: 380, x1: 700 },
  lines: rows.map(([x, intensity, label]) => ({ x, intensity, label, type })).sort((a, b) => a.x - b.x),
});

/** The eight meteorites as reflectance layers (ids like 'allende'), plus two demonstration line lists. */
export const EXAMPLE_LAYERS = [
  ...EXAMPLE_LINES.map(line => {
    const sp = decodeExample(line);
    return {
      id: slugify(sp.name.replace(/\s*\(.*$/, '')), name: sp.name, kind: 'sampled', quantity: 'reflectance',
      axis: { unit: 'nm', x0: sp.x0, x1: sp.x1 }, x: sp.x, y: sp.y,
    };
  }),
  lineLayer('ism-absorption', 'ISM absorption lines (demonstration data, approximate rest wavelengths)', 'abs', [
    [588.995, 1.0, 'Na I D2'], [589.592, 0.8, 'Na I D1'], [393.366, 1.0, 'Ca II K'], [396.847, 0.85, 'Ca II H'],
  ]),
  lineLayer('nebula-emission', 'Nebular emission lines (demonstration data, approximate rest wavelengths)', 'em', [
    [656.28, 1.0, 'Hα'], [486.13, 0.35, 'Hβ'], [434.05, 0.16, 'Hγ'], [410.17, 0.09, 'Hδ'],
    [500.7, 0.9, '[O III] 500.7'], [495.9, 0.3, '[O III] 495.9'],
    [658.3, 0.35, '[N II] 658.3'], [654.8, 0.12, '[N II] 654.8'],
    [671.6, 0.15, '[S II] 671.6'], [673.1, 0.12, '[S II] 673.1'],
  ]),
];
