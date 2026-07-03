import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

describe('Test infrastructure', () => {
  it('renders a component', () => {
    render(<Text>Hello Trail Companion</Text>);
    expect(screen.getByText('Hello Trail Companion')).toBeTruthy();
  });
});
