-- MySQL database initialization for XAMPP
CREATE DATABASE IF NOT EXISTS ict_ticketing;
USE ict_ticketing;

CREATE TABLE tickets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ticket_number VARCHAR(20) UNIQUE NOT NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    category VARCHAR(50) NOT NULL,
    priority VARCHAR(20) DEFAULT 'medium',
    status VARCHAR(20) DEFAULT 'open',
    assigned_to VARCHAR(100),
    created_by VARCHAR(100) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    resolution TEXT
);

CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(200) NOT NULL,
    role VARCHAR(20) DEFAULT 'staff',
    department VARCHAR(50)
);

-- Insert sample data
INSERT INTO users (username, email, password_hash, role, department) VALUES
('admin', 'admin@ict.com', 'admin123', 'admin', 'ICT'),
('staff1', 'staff1@ict.com', 'staff123', 'staff', 'Support');

INSERT INTO tickets (ticket_number, title, description, category, priority, created_by) VALUES
('ICT-00001', 'Printer not working', 'Printer on 3rd floor not responding', 'Hardware', 'high', 'staff1'),
('ICT-00002', 'Software installation', 'Need Photoshop installed on workstation 5', 'Software', 'medium', 'staff1');
