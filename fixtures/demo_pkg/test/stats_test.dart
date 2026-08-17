import 'package:demo_pkg/stats.dart';
import 'package:test/test.dart';

void main() {
  test('averages values', () {
    expect(average([1, 2, 3]), 2.0);
  });

  test('empty list averages to zero', () {
    expect(average([]), 0.0);
  });
}
